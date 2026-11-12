export function createJob({ source, externalId, title, description, url, budget = '' }) {
  return { source, external_id: externalId, title, description, url, budget };
}
