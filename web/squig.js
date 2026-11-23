// squig.link: reviewers' measurements of in-ears, read from this device, the Q2 not asked. Its
// squigsites.json lists the reviewers, a site each on squig.link; a site's data/phone_book.json its
// earphones, and data/<file> L.txt and R.txt each side's measurement. The targets are squig.link's
// own, in its data/ as <name> Target.txt. Sites on other domains are left out: the page's CSP lets it
// reach squig.link alone. Loaded by index.html as window.Q2Squig and by squig.test.mjs as a module.
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.Q2Squig = make();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HOME = 'https://squig.link';
  const SITES = `${HOME}/squigsites.json`;
  const TARGETS = ['Harman IE 2019', 'Super 22', 'Crinacle 2023 Adjusted', 'Δ 10dB'];
  const targetUrl = (name) => `${HOME}/data/${encodeURIComponent(`${name} Target.txt`)}`;

  // The in-ear databases squigsites.json lists, on squig.link: { id, name, base }, by name.
  function sites(list) {
    const out = [];
    for (const site of Array.isArray(list) ? list : []) {
      const user = String(site?.username ?? '');
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(user)) continue;
      const host = { subdomain: `https://${user}.squig.link`, labFolder: `${HOME}/lab/${user}`, root: HOME }[site.urlType];
      if (!host) continue;
      const dbs = (Array.isArray(site.dbs) ? site.dbs : []).filter((db) => db?.type === 'IEMs' && /^\/([\w-]+\/)*$/.test(String(db.folder)));
      for (const db of dbs) {
        const name = String(site.name || user).trim();
        out.push({ id: `${user}${db.folder}`, name: db.folder === '/' ? name : `${name} (${db.folder.slice(1, -1)})`, base: `${host}${db.folder}` });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  }

  // A site's phone book as rows: { name, file }, a measurement each, a model's variants each a row.
  // Brands whose name starts with _ are the site's own (an EQ sandbox), not earphones.
  function phones(book) {
    const out = [];
    for (const brand of Array.isArray(book) ? book : []) {
      const maker = String(brand?.name ?? '').trim();
      if (maker.startsWith('_')) continue;
      for (const phone of Array.isArray(brand?.phones) ? brand.phones : []) {
        const model = String(typeof phone === 'string' ? phone : phone?.name ?? '').trim();
        const files = typeof phone === 'string' ? [phone] : [].concat(phone?.file ?? []);
        const suffixes = [].concat(phone?.suffix ?? []);
        const named = maker && !model.toLowerCase().startsWith(maker.toLowerCase()) ? `${maker} ${model}` : model;
        files.forEach((file, index) => {
          if (typeof file !== 'string' || !file.trim()) return;
          const variant = files.length > 1 ? String(suffixes[index] ?? file).trim() : '';
          const name = variant ? `${named} ${variant}` : named;
          if (name) out.push({ name, file, find: name.toLowerCase() });
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  }

  const bookUrl = (site) => `${site.base}data/phone_book.json`;
  // Each side's measurement: a site without one side's file has the other alone.
  const sideUrls = (site, file) => ['L', 'R'].map((side) => `${site.base}data/${encodeURIComponent(`${file} ${side}.txt`)}`);

  return { HOME, SITES, TARGETS, targetUrl, sites, phones, bookUrl, sideUrls };
});
