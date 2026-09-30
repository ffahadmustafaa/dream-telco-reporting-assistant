import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let _app: App | null = null;
let _db: Firestore | null = null;
let _warned = false;

function readConfig() {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const rawKey = process.env.FIREBASE_PRIVATE_KEY?.trim();
  // Vercel env vars often carry the key with escaped newlines; restore them.
  const privateKey = rawKey?.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

/** Firebase Admin app, or null when credentials are not configured. */
export function getFirebaseApp(): App | null {
  if (_app) return _app;
  const config = readConfig();
  if (!config) {
    if (!_warned) {
      _warned = true;
      console.warn("[Firebase] FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY are not set; database features are disabled.");
    }
    return null;
  }
  try {
    _app = getApps().length ? getApps()[0]! : initializeApp({ credential: cert(config) });
  } catch (error) {
    console.warn("[Firebase] Failed to initialize:", error);
    _app = null;
  }
  return _app;
}

/** Firestore instance, or null when Firebase is not configured. */
export function getFirestoreDb(): Firestore | null {
  if (_db) return _db;
  const app = getFirebaseApp();
  if (!app) return null;
  try {
    _db = getFirestore(app);
  } catch (error) {
    console.warn("[Firebase] Failed to get Firestore:", error);
    _db = null;
  }
  return _db;
}

/** True when Firebase credentials are present. */
export function isFirebaseConfigured(): boolean {
  return getFirebaseApp() !== null;
}
