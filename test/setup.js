import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { getFunctions } from "firebase/functions";
import { firebaseConfig } from "./firebase-config.js";

// Firebase を初期化
const app = initializeApp(firebaseConfig);

// Firebase インスタンスをエクスポート（テストで使用）
export const firestore = getFirestore(app);
export const auth = getAuth(app);
export const functions = getFunctions(app);
