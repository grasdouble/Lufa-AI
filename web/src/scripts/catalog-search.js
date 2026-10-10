export function matchesCatalogItem(item, filters) {
  const query = filters.query.trim().toLocaleLowerCase();
  const searchableText = item.searchText.toLocaleLowerCase();
  const matchesQuery = !query || searchableText.includes(query);
  const matchesType = !filters.type || item.type === filters.type;
  const matchesEnvironment =
    !filters.environment || item.environments.includes(filters.environment);
  const matchesCategory =
    !filters.category || item.categories.includes(filters.category);

  return matchesQuery && matchesType && matchesEnvironment && matchesCategory;
}

export function initializeCatalogSearch(root = document) {
  const form = root.querySelector('#catalog-filters');

  if (form) {
    const cards = [...root.querySelectorAll('[data-artifact-card]')].map(
      (element) => ({
        element,
        searchText: element.dataset.search ?? '',
        type: element.dataset.type ?? '',
        environments: (element.dataset.environments ?? '')
          .split(' ')
          .filter(Boolean),
        categories: JSON.parse(element.dataset.categories ?? '[]'),
      }),
    );
    const queryInput = root.querySelector('#catalog-query');
    const typeSelect = root.querySelector('#filter-type');
    const environmentSelect = root.querySelector('#filter-environment');
    const categorySelect = root.querySelector('#filter-category');
    const noResults = root.querySelector('#no-results');
    const visibleCount = root.querySelector('#visible-count');
    const resultLabel = root.querySelector('#result-label');

    const updateResults = () => {
      const filters = {
        query: queryInput.value,
        type: typeSelect.value,
        environment: environmentSelect.value,
        category: categorySelect.value,
      };
      let count = 0;

      for (const card of cards) {
        const visible = matchesCatalogItem(card, filters);
        card.element.hidden = !visible;
        if (visible) count += 1;
      }

      noResults.hidden = count !== 0;
      visibleCount.textContent = String(count);
      resultLabel.textContent = count === 1 ? 'résultat' : 'résultats';
    };

    form.addEventListener('input', updateResults);
    form.addEventListener('change', updateResults);
    form.addEventListener('submit', (event) => event.preventDefault());
    form.addEventListener('reset', () => requestAnimationFrame(updateResults));
  }
}

if (typeof document !== 'undefined') initializeCatalogSearch();
