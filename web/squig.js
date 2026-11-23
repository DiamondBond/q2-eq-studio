// squig.link: reviewers' frequency-response measurements, read by this phone or computer (the Q2 has
// no part in it) to show one under the EQ. squigsites.json lists the reviewers, each a site on
// squig.link with a database or more (in-ears, headphones...); a database's data/phone_book.json lists
// what it measured, and each side's measurement is a text file of frequencies and levels. Sites on
// other domains are left out: the page's CSP reaches squig.link alone. Loaded by index.html as
// window.Q2Squig and by squig.test.mjs as a module.
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.Q2Squig = make();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HOME = 'https://squig.link';
  const SITES = `${HOME}/squigsites.json`;
  // Each kind of database and its name, in the order the picker groups them.
  const KINDS = [['IEMs', 'In-ears'], ['Headphones', 'Headphones'], ['Earbuds', 'Earbuds'], ['5128', 'On a B&K 5128']];
  const ORDER = KINDS.map(([kind]) => kind);
  const HOSTS = { subdomain: (user) => `https://${user}.squig.link`, labFolder: (user) => `${HOME}/lab/${user}`, root: () => HOME };

  // The databases squigsites.json lists on squig.link: { id, name, kind, base }, by kind then name.
  function sites(list) {
    const out = [];
    for (const site of Array.isArray(list) ? list : []) {
      const user = String(site?.username ?? '');
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(user) || !Object.hasOwn(HOSTS, site.urlType)) continue;
      const dbs = (Array.isArray(site.dbs) ? site.dbs : [])
        .filter((db) => ORDER.includes(db?.type) && /^\/([\w-]+\/)*$/.test(String(db.folder)));
      for (const db of dbs) {
        const name = String(site.name || user).trim();
        // A second database of the same kind is told apart by its folder.
        const twin = dbs.filter((other) => other.type === db.type).length > 1 && db.folder !== '/';
        out.push({ id: `${user}${db.folder}`, name: twin ? `${name} (${db.folder.slice(1, -1)})` : name, kind: db.type, base: `${HOSTS[site.urlType](user)}${db.folder}` });
      }
    }
    return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  }

  const starts = (text, start) => text.toLowerCase().startsWith(start.toLowerCase());

  // A phone book as rows, { name, file, find }, one a measurement, named as squig.link names them: a
  // model's variants by their suffix, by their file less its prefix, or by their file. Brands named
  // _ something are the site's own (an EQ sandbox), not earphones.
  function phones(book) {
    const out = [];
    for (const brand of Array.isArray(book) ? book : []) {
      const maker = String(brand?.name ?? '').trim();
      if (maker.startsWith('_')) continue;
      for (const phone of Array.isArray(brand?.phones) ? brand.phones : []) {
        const model = String(typeof phone === 'string' ? phone : phone?.name ?? '').trim();
        const files = [].concat(typeof phone === 'string' ? phone : phone?.file ?? phone?.name ?? []);
        const by = phone?.collab ? `${maker} x ${String(phone.collab).trim()}` : maker;
        const named = !by || starts(model, by) ? model : `${by} ${model}`;
        files.forEach((file, index) => {
          if (typeof file !== 'string' || !file.trim()) return;
          let name = named;
          if (files.length > 1 && Array.isArray(phone.suffix)) {
            name = `${named} ${String(phone.suffix[index] ?? '').trim()}`;
          } else if (files.length > 1 && typeof phone.prefix === 'string') {
            name = `${named} ${starts(file, phone.prefix) ? file.slice(phone.prefix.length).trim() : file}`;
          } else if (files.length > 1) {
            name = !maker || starts(file, maker) ? file : `${maker} ${file}`;
          }
          name = name.trim();
          if (name) out.push({ name, file, find: name.toLowerCase() });
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  }

  const bookUrl = (base) => `${base}data/phone_book.json`;
  // Where sites keep a side's file: most in data/, some in a folder of it, some as numbered samples
  // (L1, L2...: the first is taken).
  const LAYOUTS = [['data/', ''], ['data/', '1'], ['data/phones/', ''], ['data/measurements/', ''], ['data/phones/', '1'], ['data/measurements/', '1']];
  const sideUrls = (base, file, [dir, sample]) => ['L', 'R'].map((side) => `${base}${dir}${encodeURIComponent(`${file} ${side}${sample}.txt`)}`);

  // A measurement as text: a frequency and a level a line, a phase after them ignored, other lines
  // (notes, headings) skipped.
  function readCurve(text) {
    const points = [];
    for (const line of String(text).split(/\r?\n/)) {
      const [f, level] = line.trim().split(/[\s,;]+/).map(Number);
      if (Number.isFinite(f) && Number.isFinite(level) && f > 0) points.push([f, level]);
    }
    return points.sort((a, b) => a[0] - b[0]);
  }

  // A curve's level at f: straight between its points on a log scale, flat past its ends.
  function at(points, f) {
    let [low, high] = [0, points.length - 1];
    if (f <= points[low][0]) return points[low][1];
    if (f >= points[high][0]) return points[high][1];
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (points[mid][0] <= f) low = mid;
      else high = mid;
    }
    const [[f0, a], [f1, b]] = [points[low], points[high]];
    return f1 === f0 ? a : a + (b - a) * Math.log(f / f0) / Math.log(f1 / f0);
  }

  // The sides averaged on a 1/48-octave grid, 0 dB their mean from 500 Hz to 2 kHz, where the EQ's
  // 0 dB line can sit on it.
  const GRID = [];
  for (let f = 20; f <= 20000; f *= 2 ** (1 / 48)) GRID.push(f);
  function average(curves) {
    const levels = GRID.map((f) => curves.reduce((sum, curve) => sum + at(curve, f), 0) / curves.length);
    const mid = levels.filter((_, i) => GRID[i] >= 500 && GRID[i] <= 2000);
    const centre = mid.reduce((sum, level) => sum + level, 0) / mid.length;
    return GRID.map((f, i) => [f, levels[i] - centre]);
  }

  return { HOME, SITES, KINDS, LAYOUTS, sites, phones, bookUrl, sideUrls, readCurve, at, average };
});
