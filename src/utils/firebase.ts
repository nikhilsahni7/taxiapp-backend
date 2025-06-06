// src/utils/firebase.ts
import admin from "firebase-admin";
import { readFileSync } from "fs";
import { join } from "path";

const serviceAccountPath = join(
  import.meta.dir,
  "../../taxibala-a8a10-firebase-adminsdk-fbsvc-8d42ae3e5e.json"
);

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf-8"));

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export default admin;
