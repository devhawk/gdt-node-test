import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { BodyData } from 'hono/utils/body';
import bs58 from 'bs58';
import JSON5 from 'json5';
import { webcrypto as crypto } from 'node:crypto'
import { BufferSource } from 'node:stream/web';
import { File } from 'node:buffer';
import { StorageSharedKeyCredential, ContainerClient } from '@azure/storage-blob';

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

interface ProvenancePost extends BodyData {
    deviceKey: string,
    provenanceRecord: string,
    attachment?: File[]
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
            gdtContentType: contentType,
            gdtHash: toHex(await sha256(data)),
            gdtSalt: toHex(salt)
        },
        blobHTTPHeaders: {
            blobContentType: "application/octet-stream"
        }
    });
    return blobName;
}

const app = new Hono()
    .get('/', (c) => c.text('Hello Hono!'))
    .post('/api/provenance', async (c) => {
        try {
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
