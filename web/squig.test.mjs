// node --test web/: squig.link's site list, phone books and measurements as EQ Studio reads them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import squig from './squig.js';

test("sites: each database on squig.link by kind then name, others' domains and odd entries left out", () => {
  const list = squig.sites([
    { username: 'precog', name: 'Precogvision', urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/' }] },
    { username: 'hana', name: 'Hana', urlType: 'labFolder', dbs: [{ type: 'IEMs', folder: '/' }] },
    { username: 'superreview', name: 'Super* Review', urlType: 'root', dbs: [{ type: 'Headphones', folder: '/headphones/' }, { type: 'IEMs', folder: '/' }] },
    { username: 'crinacle', name: 'Hangout.Audio', urlType: 'altDomain', altDomain: 'https://graph.hangout.audio', dbs: [{ type: 'IEMs', folder: '/iem/711/' }] },
    { username: 'two', name: 'Two', urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/' }, { type: 'IEMs', folder: '/b/' }] },
    { username: 'bad.host', name: 'Bad', urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/' }] },
    { username: 'odd', name: 'Odd', urlType: 'subdomain', dbs: [{ type: 'IEMs', folder: '/../x/' }, { type: 'toString', folder: '/' }] },
    { username: 'proto', name: 'Proto', urlType: 'constructor', dbs: [{ type: 'IEMs', folder: '/' }] },
    { username: 'rig', name: 'Rig', urlType: 'subdomain', dbs: [{ type: '5128', folder: '/' }] },
  ]);
  assert.deepEqual(list.map((site) => [site.kind, site.name, site.base]), [
    ['IEMs', 'Hana', 'https://squig.link/lab/hana/'],
    ['IEMs', 'Precogvision', 'https://precog.squig.link/'],
    ['IEMs', 'Super* Review', 'https://squig.link/'],
    ['IEMs', 'Two', 'https://two.squig.link/'],
    ['IEMs', 'Two (b)', 'https://two.squig.link/b/'],
    ['Headphones', 'Super* Review', 'https://squig.link/headphones/'],
    ['5128', 'Rig', 'https://rig.squig.link/'],
  ]);
  assert.deepEqual(squig.sites(null), []);
});

test('phones: a row a measurement, named as squig.link names them, the brand said once', () => {
  const rows = squig.phones([
    { name: '_EQ', phones: [{ name: 'Sandbox', file: 'EQ sandbox' }] },
    { name: '64 Audio', phones: [{ name: 'U12t', file: '64 Audio U12t' }, { name: '64 Audio Nio', file: ['Nio m15', 'Nio m20'], suffix: ['(m15)', ''] }] },
    { name: 'Kinera', phones: [{ name: 'Verdandi TWS', file: ['Kinera Verdandi TWS (aptX)', 'Kinera Verdandi TWS (SBC)'], prefix: 'Kinera Verdandi TWS' }] },
    { name: 'qdc', phones: [{ name: 'Anole VX', file: ['Anole VX (DDD)', 'qdc Anole VX (DDB)'] }, { name: 'Tiger' }] },
    { name: 'Moondrop', phones: ['Aria', { name: 'Dusk', collab: 'Crinacle', file: 'Dusk' }, { name: 'Bad', file: 7 }] },
  ]);
  assert.deepEqual(rows.map((row) => [row.name, row.file]), [
    ['64 Audio Nio', 'Nio m20'],
    ['64 Audio Nio (m15)', 'Nio m15'],
    ['64 Audio U12t', '64 Audio U12t'],
    ['Kinera Verdandi TWS (aptX)', 'Kinera Verdandi TWS (aptX)'],
    ['Kinera Verdandi TWS (SBC)', 'Kinera Verdandi TWS (SBC)'],
    ['Moondrop Aria', 'Aria'],
    ['Moondrop x Crinacle Dusk', 'Dusk'],
    ['qdc Anole VX (DDB)', 'qdc Anole VX (DDB)'],
    ['qdc Anole VX (DDD)', 'Anole VX (DDD)'],
    ['qdc Tiger', 'Tiger'],
  ]);
  assert.deepEqual(squig.phones({}), []);
});

test("a measurement's addresses, each layout a site keeps them in, the name encoded", () => {
  const base = 'https://precog.squig.link/';
  assert.equal(squig.bookUrl(base), 'https://precog.squig.link/data/phone_book.json');
  assert.deepEqual(squig.sideUrls(base, 'Tin #1?', squig.LAYOUTS[0]), [
    'https://precog.squig.link/data/Tin%20%231%3F%20L.txt',
    'https://precog.squig.link/data/Tin%20%231%3F%20R.txt',
  ]);
  assert.deepEqual(squig.sideUrls(base, 'HD 600', ['data/phones/', '1']), [
    'https://precog.squig.link/data/phones/HD%20600%20L1.txt',
    'https://precog.squig.link/data/phones/HD%20600%20R1.txt',
  ]);
});

test('readCurve takes REW and squig.link text: notes, tabs, commas and a phase after the level', () => {
  const points = squig.readCurve('* Measurement data measured by REW\n* Note:\n20.5\t101.2\t170.1\n1000, 98.5\nfrequency,raw\n500 99\n');
  assert.deepEqual(points, [[20.5, 101.2], [500, 99], [1000, 98.5]]);
});

test('average: the sides on a log grid, 0 dB about 1 kHz, flat past their ends', () => {
  const left = [[100, 90], [1000, 100], [10000, 110]];
  const right = [[100, 94], [1000, 104], [10000, 114]];
  const curve = squig.average([left, right]);
  const level = (f) => squig.at(curve, f);
  assert.ok(Math.abs(level(1000)) < 0.05, `1 kHz: ${level(1000)}`); // 500 Hz to 2 kHz average to 0
  assert.ok(Math.abs(level(100) - level(1000) + 10) < 0.05);
  assert.ok(Math.abs(level(20) - level(100)) < 0.05 && Math.abs(level(20000) - level(10000)) < 0.05);
  assert.equal(squig.at([[100, 1], [100, 3], [200, 5]], 100), 1);
});
