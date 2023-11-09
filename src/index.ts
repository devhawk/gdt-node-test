import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { BodyData } from 'hono/utils/body';
import bs58 from 'bs58';
import JSON5 from 'json5';
import { webcrypto as crypto } from 'node:crypto'
import { BufferSource } from 'node:stream/web';
import { File } from 'node:buffer';

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

const app = new Hono()
    .get('/', (c) => c.text('Hello Hono!'))
    .post('/api/provenance', async (c) => {
        try {
            const body = await c.req.parseBody<ProvenancePost>({ all: true });
            const deviceKey = decodeKey(body.deviceKey);
            const deviceID = calculateDeviceID(deviceKey);
            const record = JSON5.parse(body.provenanceRecord);
            const attachments = new Array<string>();
            for (const attach of body.attachment ?? []) {
                const data = await attach.arrayBuffer()
                const contentType = attach.type;
                const { salt, encryptedData } = await encrypt(deviceKey, data);
                const attachmentID = toHex(await sha256(encryptedData));
                // put encrypted data to /:deviceID/attach/:attachmentID
                // with salt and contentType headers 
                attachments.push(attachmentID);
            }

            const $record = new TextEncoder().encode(JSON.stringify({ record, attachments }));
            const { salt, encryptedData } = await encrypt(deviceKey, $record);
            const recordID = await sha256(encryptedData);
            // put encrypted data to /:deviceID/prov/:recordID
            // with salt header

            return c.json({ salt: Buffer.from(salt).toString("hex") });
        } catch (e) {
            console.error(e);
            throw e;
        }
    });

serve(app)
