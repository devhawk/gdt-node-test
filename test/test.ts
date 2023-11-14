import { File } from 'node:buffer';
import fs from 'node:fs/promises'
import path from 'node:path'
import JSON5 from 'json5';
import mime from 'mime-types'

async function putProvRecord(deviceKey: string) {

    const record = {
        id: 95,
        title: 'Wholesale cargo lashing Belt',
        price: 930,
        quantity: 1,
        total: 930,
        discountPercentage: 17.67,
        discountedPrice: 766,
    }

    const formData = new FormData();
    formData.append("provenanceRecord", JSON5.stringify(record));
    for await (const blob of getImages()) {
        formData.append("attachment", blob);
    }
    const response = await fetch(`${baseUrl}/provenance/${deviceKey}`, {
        method: "POST",
        body: formData,
    });
    return await response.json();

    async function* getImages(): AsyncGenerator<File, void, unknown> {
        for (const fileName of await fs.readdir(__dirname)) {
            const ext = path.extname(fileName);
            if (ext === ".ts") continue;
            const type = mime.lookup(ext) || 'application/octet-stream';
            const buffer = await fs.readFile(path.join(__dirname, fileName));
            yield new File([buffer], fileName, { type });
        }
    }
}

const baseUrl = "http://localhost:3000/api";
// const baseUrl = "http://localhost:7071/api";

async function getProvRecords(deviceKey: string) {
    const response = await fetch(`${baseUrl}/provenance/${deviceKey}`, {
        method: "GET",
    });
    return await response.json() as { record: any, attachments?: string[] }[];
}

async function getAttachment(deviceKey: string, attachmentID: string) {
    const response = await fetch(`${baseUrl}/attachment/${deviceKey}/${attachmentID}`, {
        method: "GET",
    });

    console.log();
}

async function main() {
    const deviceKey = "5LAtuNjm3iuAR3ohpjTMy7";

    const $json = await putProvRecord(deviceKey);
    console.log($json);
    return;

    const json = await getProvRecords(deviceKey);
    console.log(json);

    const attachment = json[0].attachments?.[0];
    if (attachment) {
        console.log(`Downloading ${attachment}`);
        await getAttachment(deviceKey, attachment!);
    }
}

main().catch(e => console.error(e));

