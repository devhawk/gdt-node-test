import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { BodyData } from 'hono/utils/body';
import bs58 from 'bs58';
import JSON5 from 'json5';
import { webcrypto as crypto } from 'node:crypto'
import { BufferSource } from 'node:stream/web';
import { File } from 'node:buffer';
import { StorageSharedKeyCredential, ContainerClient, BlockBlobClient } from '@azure/storage-blob';

function encodeKey(key: Uint8Array): string { return bs58.encode(key); }
function decodeKey(key: string): Uint8Array { return bs58.decode(key); }

function calculateDeviceID(key: string | Uint8Array): bigint {
    // if key is a string, convert it to a buffer 
    key = typeof key === 'string' ? decodeKey(key) : key;
    return fnv1(key);
}

const fnvPrime = 1099511628211n
const fnvOffset = 14695981039346656037n

function fnv1(input: Uint8Array): bigint {
    let hash = fnvOffset;
    for (let i = 0; i < input.length; i++) {
        hash = BigInt.asUintN(64, hash * fnvPrime)
        hash ^= BigInt(input[i])
    }
    return hash;
}

async function sha256(data: BufferSource) {
    const buffer = await crypto.subtle.digest("SHA-256", data);
    return new Uint8Array(buffer);
}

function toHex(data: WithImplicitCoercion<ArrayBuffer | SharedArrayBuffer>): string {
    return Buffer.from(data).toString("hex");
}

function fromHex(hex: string): Uint8Array {
    return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function encrypt(key: Uint8Array, data: BufferSource): Promise<{ salt: Uint8Array; encryptedData: Uint8Array; }> {
    const $key = await crypto.subtle.importKey("raw", key.buffer, "AES-CBC", false, ['encrypt']);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const encryptedData = await crypto.subtle.encrypt({ name: "AES-CBC", iv: salt }, $key, data);
    return { salt, encryptedData: new Uint8Array(encryptedData) };
}


export async function decrypt(key: Uint8Array, salt: Uint8Array, encryptedData: Uint8Array): Promise<Uint8Array> {
    const $key = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["decrypt"]);
    const result = await crypto.subtle.decrypt({ name: "AES-CBC", iv: salt }, $key, encryptedData);
    return new Uint8Array(result);
  }


const cred = new StorageSharedKeyCredential(
    "devstoreaccount1",
    "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==");

async function upload(client: ContainerClient, deviceKey: Uint8Array, data: BufferSource, type: 'attach' | 'prov', contentType: string): Promise<string> {
    const { salt, encryptedData } = await encrypt(deviceKey, data);
    const dataHash = toHex(await sha256(encryptedData));
    const blobName = `${client.containerName}/${type}/${dataHash}`;
    await client.uploadBlockBlob(blobName, encryptedData.buffer, encryptedData.length, {
        metadata: {
            gdtcontenttype: contentType,
            gdthash: toHex(await sha256(data)),
            gdtsalt: toHex(salt)
        },
        blobHTTPHeaders: {
            blobContentType: "application/octet-stream"
        }
    });
    return dataHash;
}

function areEqual(first: Uint8Array, second: Uint8Array) {
    return first.length === second.length 
        && first.every((value, index) => value === second[index]);
}

async function decryptBlob(client: BlockBlobClient, deviceKey: Uint8Array) {
    const props = await client.getProperties();
    const salt = props.metadata?.["gdtsalt"];
    if (!salt) throw new Error(`Missing Salt ${client.name}`);
    const buffer = await client.downloadToBuffer();
    const data = await decrypt(deviceKey, fromHex(salt), buffer);
    const hash = props.metadata?.["gdthash"];
    if (hash) {
        if (!areEqual(fromHex(hash), await sha256(data) )) {
            throw new Error(`Invalid Hash ${client.name}`);
        }
    }
    const contentType = props.metadata?.["gdtcontenttype"];
    return { data, contentType };
}

const app = new Hono()
    .get('/', (c) => c.text('Hello Hono!'))
    .get('/api/provenance/:deviceKey', async (c) => {

        const deviceKey = decodeKey(c.req.param("deviceKey"));
        const deviceID = calculateDeviceID(deviceKey);

        const deviceClient = new ContainerClient(`http://127.0.0.1:10000/devstoreaccount1/${deviceID}`, cred);
        const exists = await deviceClient.exists();
        if (!exists) { return c.json([]); }

        const records = new Array<any>();
        for await (const blob of deviceClient.listBlobsFlat({ prefix: `${deviceID}/prov/` })) {
            const blobClient = deviceClient.getBlockBlobClient(blob.name);
            const { data } = await decryptBlob(blobClient, deviceKey);
            const json = new TextDecoder().decode(data);
            records.push(JSON.parse(json));
        }
        return c.json(records);
    })
    .get('/api/attachment/:deviceKey/:attachmentID', async (c) => {
        const deviceKey = decodeKey(c.req.param("deviceKey"));
        const deviceID = calculateDeviceID(deviceKey);
        const attachmentID = c.req.param('attachmentID');

        const deviceClient = new ContainerClient(`http://127.0.0.1:10000/devstoreaccount1/${deviceID}`, cred);
        const blobClient = deviceClient.getBlockBlobClient(`${deviceID}/attach/${attachmentID}`);
        const exists = await blobClient.exists();
        if (!exists) return c.notFound();
        const { data, contentType } = await decryptBlob(blobClient, deviceKey);
        if (contentType) {
            c.header("Content-Type", contentType);
        }
        return c.body(data);
    })
    .post('/api/provenance', async (c) => {
        try {
            interface ProvenancePost extends BodyData {
                deviceKey: string,
                provenanceRecord: string,
                attachment?: File[]
            }

            const body = await c.req.parseBody<ProvenancePost>({ all: true });
            const deviceKey = decodeKey(body.deviceKey);
            const deviceID = calculateDeviceID(deviceKey);

            const deviceClient = new ContainerClient(`http://127.0.0.1:10000/devstoreaccount1/${deviceID}`, cred);
            await deviceClient.createIfNotExists();

            const attachments = new Array<string>();
            if (body.attachment && body.attachment.length > 0) {
                for (const attach of body.attachment) {
                    const data = await attach.arrayBuffer()
                    const blobName = await upload(deviceClient, deviceKey, data, "attach", attach.type);
                    attachments.push(blobName);
                }
            }

            {
                const record = JSON5.parse(body.provenanceRecord);
                const data = new TextEncoder().encode(JSON.stringify({ record, attachments }));
                const blobName = await upload(deviceClient, deviceKey, data, "prov", "application/json");
                return c.json({ record: blobName, attachments });
            }
        } catch (e) {
            console.error(e);
            throw e;
        }
    });

serve(app)
