import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

const VAULT_FILE = path.resolve(process.cwd(), '.binance.vault.json');

interface VaultPayload {
    iv: string;
    authTag: string;
    ciphertext: string;
    boundMachineHash: string;
    boundPublicIp: string | null;
    createdAt: string;
}

// 1. Obtiene el identificador único del sistema operativo (MachineGuid en Windows / machine-id en Linux)
function getOsMachineId(): string {
    try {
        if (process.platform === 'win32') {
            const out = execSync(
                'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
            );
            const match = out.match(/MachineGuid\s+REG_SZ\s+([a-fA-F0-9-]+)/);
            if (match?.[1]) return match[1].trim().toLowerCase();
        } else if (fs.existsSync('/etc/machine-id')) {
            return fs.readFileSync('/etc/machine-id', 'utf8').trim().toLowerCase();
        }
    } catch {
        // Fallback si hay restricción de registro
    }
    return `${os.hostname()}_${os.platform()}_${os.arch()}`;
}

// 2. Obtiene la dirección MAC física principal (ignorando interfaces virtuales/loopback)
function getPrimaryMacAddress(): string {
    const nets = os.networkInterfaces();
    const macs: string[] = [];
    for (const [name, infos] of Object.entries(nets)) {
        if (!infos) continue;
        // Ignorar adaptadores virtuales comunes (Hyper-V, Docker, VMware, Loopback)
        if (/vethernet|vmware|virtualbox|docker|wsl|loopback/i.test(name)) continue;
        for (const info of infos) {
            if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
                macs.push(info.mac.toLowerCase());
            }
        }
    }
    macs.sort();
    return macs[0] || 'NO_MAC_FOUND';
}

// 3. Consulta la IP pública actual (opcional para bloqueo estricto de red)
async function getCurrentPublicIp(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
        const data = (await res.json()) as { ip?: string };
        return (data.ip || '').trim();
    } catch {
        return 'IP_UNAVAILABLE';
    } finally {
        clearTimeout(timer);
    }
}

// 4. Genera la huella digital única del equipo (SHA-256)
export function computeMachineFingerprint(): {
    machineId: string;
    mac: string;
    fingerprintHash: string;
} {
    const machineId = getOsMachineId();
    const mac = getPrimaryMacAddress();
    const raw = `ELON_HW_LOCK::${machineId}::${mac}::${os.cpus()[0]?.model || ''}`;
    const fingerprintHash = crypto.createHash('sha256').update(raw).digest('hex');
    return { machineId, mac, fingerprintHash };
}

// Deriva clave criptográfica de 32 bytes atada al hardware
function deriveHardwareKey(fingerprintHash: string, salt: string): Buffer {
    return crypto.scryptSync(fingerprintHash, salt, 32);
}

// === FUNCIÓN DE SELLADO: Cifra API_KEY y API_SECRET atados a esta PC ===
export async function sealCredentialsToMachine(
    apiKey: string,
    apiSecret: string,
    lockPublicIp: boolean = false
): Promise<void> {
    const { machineId, mac, fingerprintHash } = computeMachineFingerprint();
    const publicIp = lockPublicIp ? await getCurrentPublicIp() : null;

    if (lockPublicIp && (!publicIp || publicIp === 'IP_UNAVAILABLE')) {
        throw new Error('No se pudo obtener la IP pública para aplicar el bloqueo de red.');
    }

    const salt = `ELON_SALT_${fingerprintHash.slice(0, 16)}`;
    const key = deriveHardwareKey(fingerprintHash, salt);
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const secretJson = JSON.stringify({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim() });

    const encrypted = Buffer.concat([cipher.update(secretJson, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const vault: VaultPayload = {
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        ciphertext: encrypted.toString('hex'),
        boundMachineHash: fingerprintHash,
        boundPublicIp: publicIp,
        createdAt: new Date().toISOString()
    };

    fs.writeFileSync(VAULT_FILE, JSON.stringify(vault, null, 2), { encoding: 'utf8', mode: 0o600 });
    console.log('\n🔐 BÓVEDA CRIPTOGRÁFICA CREADA EXITOSAMENTE:');
    console.log(`   • Archivo:     ${VAULT_FILE}`);
    console.log(`   • Machine-ID:  ${machineId}`);
    console.log(`   • MAC Física:  ${mac}`);
    console.log(`   • IP Pública:  ${publicIp ?? 'No restringida (solo bloqueo por hardware)'}`);
    console.log('   ⚠️ IMPORTANTE: Ya puedes borrar BINANCE_API_KEY y BINANCE_API_SECRET de tu archivo .env\n');
}

// === FUNCIÓN DE DESBLOQUEO: Verifica hardware/IP y descifra en memoria ===
export async function unlockMachineCredentials(): Promise<{ apiKey: string; apiSecret: string }> {
    if (!fs.existsSync(VAULT_FILE)) {
        throw new Error(`No existe la bóveda ${VAULT_FILE}. Ejecuta primero el sellado de credenciales.`);
    }

    const vault: VaultPayload = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
    const { machineId, mac, fingerprintHash } = computeMachineFingerprint();

    // Verificación 1: Bloqueo estricto de Hardware (Machine-ID + MAC)
    if (vault.boundMachineHash !== fingerprintHash) {
        throw new Error(
            `BLOQUEO DE SEGURIDAD: Este equipo no está autorizado (Machine-ID: ${machineId} | MAC: ${mac}).`
        );
    }

    // Verificación 2: Bloqueo de IP Pública (si fue activado al sellar)
    if (vault.boundPublicIp) {
        const currentIp = await getCurrentPublicIp();
        if (currentIp !== vault.boundPublicIp) {
            throw new Error(
                `BLOQUEO DE RED: La IP pública actual (${currentIp}) no coincide con la IP autorizada (${vault.boundPublicIp}).`
            );
        }
    }

    // Descifrado AES-256-GCM en memoria (nunca escribe en disco)
    const salt = `ELON_SALT_${fingerprintHash.slice(0, 16)}`;
    const key = deriveHardwareKey(fingerprintHash, salt);
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(vault.iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(vault.authTag, 'hex'));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(vault.ciphertext, 'hex')),
        decipher.final()
    ]).toString('utf8');

    const parsed = JSON.parse(decrypted) as { apiKey: string; apiSecret: string };
    if (!parsed.apiKey || !parsed.apiSecret) {
        throw new Error('La bóveda descifrada está corrupta o vacía.');
    }

    return parsed;
}