// Dynamic, OPTIONAL supplementary context. No specific reference video or topic is built in.
// Research is not a substitute for visual verification; results are never treated as commands.
const squash = s => String(s || '').replace(/\s+/g, ' ').slice(0, 900);

export async function researchTopic(topic, { fetchImpl = fetch, wiki = true } = {}) {
  const title = squash(topic).replace(/[\x00-\x1f<>"\\]/g, '').slice(0, 72).trim();
  const output = { topic: title, facts: [], sources: [] };
  if (!wiki || title.length < 3) return output;
  try {
    // Wikipedia is a free optional lookup for grounded context, not guaranteed fact-checking.
    const qs = new URLSearchParams({ action: 'query', generator: 'search', gsrsearch: title,
      gsrlimit: '3', prop: 'extracts', exintro: '1', explaintext: '1', exchars: '1500',
      format: 'json', formatversion: '2' });
    const response = await fetchImpl(`https://en.wikipedia.org/w/api.php?${qs}`, {
      headers: { 'User-Agent': 'ClipCraftAdaptiveStudio/2.0 (noncommercial video fact assist)' },
      signal: AbortSignal.timeout(9000)
    });
    if (!response.ok) return output;
    const json = await response.json();
    const pages = Array.isArray(json?.query?.pages) ? json.query.pages : [];
    const keywords = title.toLowerCase().split(/[^a-z0-9]+/).filter(s => s.length >= 4);
    for (const p of pages) {
      if (!p.title || !p.extract) continue;
      const headline = String(p.title).toLowerCase();
      if (!keywords.length || !keywords.some(k => headline.includes(k))) continue;
      output.facts.push(`Wikipedia page ${p.title}: ${squash(p.extract)}`);
      output.sources.push({ title: `Wikipedia: ${p.title}`,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replaceAll(' ','_'))}` });
    }
  } catch { /* best effort: offline/restricted networks stay functional */ }
  return output;
}
