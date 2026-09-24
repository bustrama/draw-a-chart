/**
 * Consistent backup of the database while the server runs:
 *   docker compose exec draw-a-chart node --disable-warning=ExperimentalWarning server/backup.ts [file]
 * Default target: $DATA_DIR/backup-<time>.sqlite. Prints the path it wrote.
 */
import { join } from 'node:path';
import { backupDatabase } from './store.ts';

const dataDir = process.env.DATA_DIR || 'data';
const source = process.env.DB_FILE || join(dataDir, 'draw-a-chart.sqlite');
const target = process.argv[2] || join(dataDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
backupDatabase(source, target);
console.log(target);
