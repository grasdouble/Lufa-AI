import index from '../../../generated/catalog-index.json';

export type Compatibility = {
  environment: string;
  level: 'declared' | 'verified';
  evidence?: {
    testedVersion: string;
    method: string;
    reference: string;
  };
};

export type CatalogFile = {
  path: string;
  destination: string;
};

export type ArtifactVersion = {
  version: string;
  publishedAt: string;
  files: CatalogFile[];
  compatibilities: Compatibility[];
  prerequisites: string[];
  warnings: string[];
};

export type CatalogArtifact = {
  id: string;
  name: string;
  description: string;
  type: string;
  authors: string[];
  provenance: {
    repository: string;
    license: string;
  };
  discovery: {
    categories: string[];
    keywords: string[];
  };
  versions: ArtifactVersion[];
};

export const artifacts = index.artifacts as CatalogArtifact[];

export const environments = [...new Set(
  artifacts.flatMap((artifact) =>
    artifact.versions.flatMap((version) =>
      version.compatibilities.map(({ environment }) => environment),
    ),
  ),
)].sort();

export const categories = [...new Set(
  artifacts.flatMap((artifact) => artifact.discovery.categories),
)].sort();
