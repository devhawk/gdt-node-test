import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { BodyData } from 'hono/utils/body';
import bs58 from 'bs58';
import JSON5 from 'json5';
import { webcrypto as crypto } from 'node:crypto'
import { BufferSource } from 'node:stream/web';
import { File } from 'node:buffer';
import { StorageSharedKeyCredential, BlobServiceClient } from '@azure/storage-blob';

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

const app = new Hono()
    .get('/', (c) => c.text('Hello Hono!'))
    .post('/api/provenance', async (c) => {
        try {
            const svcClient = new BlobServiceClient("http://127.0.0.1:10000/devstoreaccount1", cred);

            const body = await c.req.parseBody<ProvenancePost>({ all: true });
            const deviceKey = decodeKey(body.deviceKey);
            const deviceID = calculateDeviceID(deviceKey);

            const attachments = new Array<string>();
            {
                const cntrClient = svcClient.getContainerClient("attach");
                const createContainerResponse = await cntrClient.createIfNotExists();

                for (const attach of body.attachment ?? []) {
                    const data = await attach.arrayBuffer()
                    const gdtContentType = attach.type;
                    const gdtHash = toHex(await sha256(data));
                    const { salt: $salt, encryptedData } = await encrypt(deviceKey, data);
                    const gdtSalt = toHex($salt);
                    const attachmentID = toHex(await sha256(encryptedData));
                    const blobName = `${deviceID}/${attachmentID}`;
                    const { blockBlobClient, response: uploadBlobResponse } = await cntrClient.uploadBlockBlob(blobName, encryptedData.buffer, encryptedData.length, {
                        metadata: { gdtContentType, gdtHash, gdtSalt },
                        blobHTTPHeaders: {
                            blobContentType: "application/octet-stream"
                        }
                    });

                    attachments.push(blobName);
                }
            }
            {
                const cntrClient = svcClient.getContainerClient("prov");
                const createContainerResponse = await cntrClient.createIfNotExists();

                const record = JSON5.parse(body.provenanceRecord);
                const $record = new TextEncoder().encode(JSON.stringify({ record, attachments }));
                const gdtHash = toHex(await sha256($record));
                const { salt: $salt, encryptedData } = await encrypt(deviceKey, $record);
                const gdtSalt = toHex($salt);
                const recordID = toHex(await sha256(encryptedData));
                const blobName = `${deviceID}/${recordID}}`;
                const { blockBlobClient, response: uploadBlobResponse } = await cntrClient.uploadBlockBlob(blobName, encryptedData.buffer, encryptedData.length, {
                    metadata: { gdtHash, gdtSalt },
                    blobHTTPHeaders: {
                        blobContentType: "application/octet-stream"
                    }
                });

                return c.json({ record: blobName, attachments });
            }
        } catch (e) {
            console.error(e);
            throw e;
        }
    });

serve(app)
