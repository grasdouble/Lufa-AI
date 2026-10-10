import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCatalogIndex, CatalogValidationError, projectRoot, validateCatalog, } from "./catalog.js";
async function main() {
    const command = process.argv[2] ?? 'validate';
    if (command === 'validate') {
        await validateCatalog();
        console.log('Catalogue valide.');
        return;
    }
    if (command === 'build') {
        const outputPath = path.join(projectRoot, 'generated', 'catalog-index.json');
        const index = await buildCatalogIndex();
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, index);
        console.log(`Index généré : ${path.relative(projectRoot, outputPath)}`);
        return;
    }
    if (command === 'check') {
        await validateCatalog();
        const outputPath = path.join(projectRoot, 'generated', 'catalog-index.json');
        let currentIndex;
        try {
            currentIndex = await readFile(outputPath, 'utf8');
        }
        catch {
            throw new CatalogValidationError('Index absent ; exécuter npm run catalog:build.');
        }
        const expectedIndex = await buildCatalogIndex();
        if (currentIndex !== expectedIndex) {
            throw new CatalogValidationError('Index périmé ou non déterministe ; exécuter npm run catalog:build.');
        }
        console.log('Catalogue et index déterministe valides.');
        return;
    }
    throw new CatalogValidationError(`Commande inconnue « ${command} » (validate, build, check).`);
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
