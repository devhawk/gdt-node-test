import { File } from 'node:buffer';
import fs from 'node:fs/promises'
import path from 'node:path'
import JSON5 from 'json5';
import mime from 'mime-types'

const record = {
    id: 95,
    title: 'Wholesale cargo lashing Belt',
    price: 930,
    quantity: 1,
    total: 930,
    discountPercentage: 17.67,
    discountedPrice: 766,
}

async function* getImages(): AsyncGenerator<File, void, unknown> {
    for (const fileName of await fs.readdir(__dirname)) {
        const ext = path.extname(fileName);
        if (ext === ".ts") continue;
        const type = mime.lookup(ext) || 'application/octet-stream';
        const buffer = await fs.readFile(path.join(__dirname, fileName));
        yield new File([buffer], fileName, { type });
    }
}

async function main() {

    const formData = new FormData();
    formData.append("deviceKey", "5LAtuNjm3iuAR3ohpjTMy7");
    formData.append("provenanceRecord", JSON5.stringify(record));
    for await (const blob of getImages()) {
        formData.append("attachment", blob);
    }
    // const response = await fetch("http://localhost:3000/api/provenance", {
    //     method: "POST",
    //     body: formData,
    // });
    // const result = await response.json();
    // console.log(result);
}

main().catch(e => console.error(e));

