import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { sealCredentialsToMachine } from './securityVault';

const envPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env')
];
for (const p of envPaths) {
    if (fs.existsSync(p)) {
        dotenv.config({ path: p });
        break;
    }
}

async function run() {
    const apiKey = (process.env.BINANCE_API_KEY || '').trim();
    const apiSecret = (process.env.BINANCE_API_SECRET || '').trim();
    // Cambia a true si quieres bloquear también por tu IP pública fija
    const lockIp = process.env.LOCK_PUBLIC_IP?.trim().toLowerCase() === 'true';

    if (!apiKey || !apiSecret) {
        console.error('❌ Coloca temporalmente BINANCE_API_KEY y BINANCE_API_SECRET en tu .env para sellarlas.');
        process.exit(1);
    }

    await sealCredentialsToMachine(apiKey, apiSecret, lockIp);
}

run();