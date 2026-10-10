#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInstallCommand } from "./install-command.js";
import { runInstalledCommand, runOutdatedCommand, runUpdateCommand, } from "./project-command.js";
import { resolveCatalogIndex, } from "./registry-index.js";
const usage = `Usage : npm run lufa -- <commande> [options]

Commandes :
  list [--json]             Lister les artefacts disponibles
  search <terme> [--json]   Rechercher dans les noms, descriptions, catégories et mots-clés
  show <identifiant> [--json]
                            Afficher le détail d’un artefact
  install <identifiant[@version]> [--project <chemin>] [--yes]
                            Installer une version dans le projet courant
  installed [--project <chemin>] [--json]
                            Lister les artefacts consignés dans lufa.lock.json
  outdated [--project <chemin>] [--json]
                            Comparer le lock aux dernières versions stables
  update [identifiant] [--project <chemin>] [--force] [--yes] [--json]
                            Prévisualiser et appliquer une mise à jour stable
  help                      Afficher cette aide

Options :
  --json                    Produire une sortie JSON stable pour list, search et show
  --project <chemin>        Cibler un dossier de projet pour install
  --yes, --non-interactive  Confirmer explicitement sans invite interactive
  --force                   Sauvegarder les fichiers locaux en conflit avant remplacement
  -h, --help                Afficher cette aide`;
class CliError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CliError';
    }
}
function toSummary(artifact) {
    return {
        id: artifact.id,
        name: artifact.name,
        description: artifact.description,
        type: artifact.type,
        categories: artifact.discovery.categories,
        keywords: artifact.discovery.keywords,
        versions: artifact.versions.map(({ version }) => version),
    };
}
function matchesSearch(artifact, query) {
    const needle = query.toLowerCase();
    const searchableFields = [
        artifact.id,
        artifact.name,
        artifact.description,
        ...artifact.discovery.categories,
        ...artifact.discovery.keywords,
    ];
    return searchableFields.some((field) => field.toLowerCase().includes(needle));
}
function printJson(value) {
    console.log(JSON.stringify(value, null, 2));
}
function printList(artifacts) {
    if (artifacts.length === 0) {
        console.log('Aucun artefact dans le catalogue.');
        return;
    }
    for (const artifact of artifacts) {
        console.log(`${artifact.id}\t${artifact.name}\t${artifact.description}`);
    }
}
function parseOptions(args) {
    const values = [];
    let json = false;
    for (const argument of args) {
        if (argument === '--json') {
            json = true;
        }
        else if (argument.startsWith('-')) {
            throw new CliError(`Option inconnue « ${argument} ». Consulter l’aide avec npm run lufa -- --help.`);
        }
        else {
            values.push(argument);
        }
    }
    return { values, json };
}
export async function runCatalogCli(args) {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(usage);
        return;
    }
    const [command, ...commandArgs] = args;
    if (command === 'install') {
        await runInstallCommand(commandArgs);
        return;
    }
    if (command === 'installed') {
        await runInstalledCommand(commandArgs);
        return;
    }
    if (command === 'outdated') {
        await runOutdatedCommand(commandArgs);
        return;
    }
    if (command === 'update') {
        await runUpdateCommand(commandArgs);
        return;
    }
    if (command === 'help') {
        if (commandArgs.length > 0) {
            throw new CliError(`Usage : npm run lufa -- help\n\n${usage}`);
        }
        console.log(usage);
        return;
    }
    if (command !== 'list' && command !== 'search' && command !== 'show') {
        throw new CliError(`Commande inconnue « ${command} ». Commandes disponibles : list, search, show, install, installed, outdated, update. Consulter l’aide avec npm run lufa -- --help.`);
    }
    const { values, json } = parseOptions(commandArgs);
    const requiredArguments = command === 'list' ? 0 : 1;
    if (values.length !== requiredArguments) {
        const expected = command === 'list'
            ? 'Usage : npm run lufa -- list [--json]'
            : command === 'search'
                ? 'Usage : npm run lufa -- search <terme> [--json]'
                : 'Usage : npm run lufa -- show <identifiant> [--json]';
        throw new CliError(`${expected}\nConsulter l’aide avec npm run lufa -- --help.`);
    }
    const { index } = await resolveCatalogIndex();
    const { artifacts } = index;
    if (command === 'list') {
        const results = artifacts.map(toSummary);
        if (json)
            printJson(results);
        else
            printList(artifacts);
        return;
    }
    if (command === 'search') {
        const query = values[0];
        if (query.trim().length === 0) {
            throw new CliError('Le terme de recherche ne peut pas être vide. Usage : npm run lufa -- search <terme> [--json].');
        }
        const results = artifacts.filter((artifact) => matchesSearch(artifact, query));
        if (json)
            printJson(results.map(toSummary));
        else if (results.length === 0) {
            console.log(`Aucun artefact trouvé pour « ${query} ».`);
        }
        else {
            printList(results);
        }
        return;
    }
    const id = values[0];
    const artifact = artifacts.find((candidate) => candidate.id === id);
    if (!artifact) {
        throw new CliError(`Artefact inconnu « ${id} ». Lister les artefacts avec npm run lufa -- list ou rechercher avec npm run lufa -- search <terme>.`);
    }
    const detail = {
        ...artifact,
        installation: {
            command: `lufa install ${artifact.id}`,
            status: 'available',
            note: 'Installe la dernière version stable ; utilisez @<version> pour choisir une version précise.',
        },
    };
    if (json)
        printJson(detail);
    else
        printArtifactDetails(artifact);
}
function printArtifactDetails(artifact) {
    console.log(`${artifact.name} (${artifact.id})`);
    console.log(`Type : ${artifact.type}`);
    console.log(`Description : ${artifact.description}`);
    console.log(`Auteurs : ${artifact.authors.join(', ')}`);
    console.log(`Dépôt : ${artifact.provenance.repository}`);
    console.log(`Licence : ${artifact.provenance.license}`);
    console.log(`Catégories : ${artifact.discovery.categories.join(', ') || '—'}`);
    console.log(`Mots-clés : ${artifact.discovery.keywords.join(', ') || '—'}`);
    console.log(`Installation : lufa install ${artifact.id}`);
    for (const version of artifact.versions) {
        console.log(`\nVersion ${version.version} (publiée le ${version.publishedAt})`);
        console.log('Fichiers :');
        for (const file of version.files) {
            console.log(`  ${file.path} → ${file.destination}`);
        }
        console.log('Compatibilités :');
        for (const compatibility of version.compatibilities) {
            console.log(`  ${compatibility.environment} : ${compatibility.level}${compatibility.evidence ? ` (preuve : ${compatibility.evidence.testedVersion}, ${compatibility.evidence.method}, ${compatibility.evidence.reference})` : ''}`);
        }
        console.log(`Prérequis : ${version.prerequisites.join('; ') || 'aucun'}`);
        console.log(`Avertissements : ${version.warnings.join('; ') || 'aucun'}`);
    }
}
const executedModulePath = (() => {
    if (!process.argv[1])
        return undefined;
    try {
        return realpathSync(process.argv[1]);
    }
    catch {
        return undefined;
    }
})();
if (executedModulePath === fileURLToPath(import.meta.url)) {
    runCatalogCli(process.argv.slice(2)).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
