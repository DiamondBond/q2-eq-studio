// node --test web/: squig.link's site list and phone books as EQ Studio reads them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import squig from './squig.js';

test("sites: each in-ear database on squig.link, by name, others' domains left out", () => {
  const list = squig.sites([
    { username: 'precog', name: 'Precogvision', urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/' }] },
    { username: 'hana', name: 'Hana', urlType: 'labFolder', dbs: [{ type: 'IEMs', folder: '/' }] },
    { username: 'superreview', name: 'Super* Review', urlType: 'root', dbs: [{ type: 'Headphones', folder: '/headphones/' }, { type: 'IEMs', folder: '/' }] },
    { username: 'crinacle', name: 'Hangout.Audio', urlType: 'altDomain', altDomain: 'https://graph.hangout.audio', dbs: [{ type: 'IEMs', folder: '/iem/711/' }] },
    { username: 'two', name: 'Two', urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/' }, { type: 'IEMs', folder: '/b/' }] },
    { username: 'bad.host', name: 'Bad', urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/' }] },
    { username: 'odd', name: 'Odd', urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/../x/' }] },
  ]);
  assert.deepEqual(list.map((site) => [site.name, site.base]), [
    ['Hana', 'https://squig.link/lab/hana/'],
    ['Precogvision', 'https://precog.squig.link/'],
    ['Super* Review', 'https://squig.link/'],
    ['Two', 'https://two.squig.link/'],
    ['Two (b)', 'https://two.squig.link/b/'],
  ]);
  assert.deepEqual(squig.sites(null), []);
});

test('phones: a row a measurement, variants named by their suffix, the brand said once', () => {
  const rows = squig.phones([
    { name: '_EQ', phones: [{ name: 'Sandbox', file: 'EQ sandbox' }] },
    { name: '64 Audio', phones: [{ name: 'U12t', file: '64 Audio U12t' }, { name: '64 Audio Nio', file: ['Nio m15', 'Nio m20'], suffix: ['(m15)', '(m20)'] }] },
    { name: 'Moondrop', phones: [{ name: 'Blessing 2', file: ['B2', 'B2 S2'] }, 'Aria', { name: 'Bad', file: 7 }] },
  ]);
  assert.deepEqual(rows.map((row) => [row.name, row.file]), [
    ['64 Audio Nio (m15)', 'Nio m15'],
    ['64 Audio Nio (m20)', 'Nio m20'],
    ['64 Audio U12t', '64 Audio U12t'],
    ['Moondrop Aria', 'Aria'],
    ['Moondrop Blessing 2 B2', 'B2'],
    ['Moondrop Blessing 2 B2 S2', 'B2 S2'],
  ]);
  assert.deepEqual(squig.phones({}), []);
});

test("a measurement's and a target's addresses, their names encoded", () => {
  const site = { base: 'https://precog.squig.link/' };
  assert.equal(squig.bookUrl(site), 'https://precog.squig.link/data/phone_book.json');
  assert.deepEqual(squig.sideUrls(site, 'Tin #1?'), [
    'https://precog.squig.link/data/Tin%20%231%3F%20L.txt',
    'https://precog.squig.link/data/Tin%20%231%3F%20R.txt',
  ]);
  assert.equal(squig.targetUrl('Δ 10dB'), 'https://squig.link/data/%CE%94%2010dB%20Target.txt');
});
