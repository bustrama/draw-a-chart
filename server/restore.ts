/**
 * Restores a backup made with server/backup.ts. The server must be stopped:
 *   docker compose stop draw-a-chart
 *   docker compose cp ./backup.sqlite draw-a-chart:/data/restore.sqlite
 *   docker compose run --rm --no-deps draw-a-chart node --disable-warning=ExperimentalWarning server/restore.ts /data/restore.sqlite
 *   docker compose start draw-a-chart
 *
 * Copies the backup into place (owned by the user running this, i.e. the server's user), removes
 * the old write-ahead log (SQLite would replay it onto the restored file), and gives the database
 * a new generation. Devices notice the new generation when they reconnect: the backup's version of
 * each drawing wins, and drawings the backup does not have are uploaded again from the devices.
 */
import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DrawingStore } from './store.ts';

const source = process.argv[2];
if (!source) {
  console.error('usage: node server/restore.ts <backup.sqlite>');
  process.exit(2);
}
const target = process.env.DB_FILE || join(process.env.DATA_DIR || 'data', 'draw-a-chart.sqlite');
for (const suffix of ['-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true });
copyFileSync(source, target);
const store = new DrawingStore(target); // also migrates a backup from an older version
const generation = store.renewGeneration();
store.close();
console.log(`restored ${source} into ${target} (generation ${generation})`);
