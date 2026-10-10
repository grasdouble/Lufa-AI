import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const packageMarkers = [
    'schemas/artifact.schema.json',
    'generated/catalog-index.json',
    'catalog',
];
export function resolvePackageRoot(moduleUrl) {
    let candidate = path.dirname(fileURLToPath(moduleUrl));
    for (let level = 0; level < 3; level += 1) {
        if (packageMarkers.every((marker) => existsSync(path.join(candidate, marker)))) {
            return candidate;
        }
        candidate = path.dirname(candidate);
    }
    throw new Error(`Impossible de trouver la racine du paquet Lufa depuis ${moduleUrl}.`);
}
