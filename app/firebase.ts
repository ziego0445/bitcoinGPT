/* eslint-disable @typescript-eslint/no-unused-vars */
// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getFirestore } from "firebase/firestore";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDSU-M6JZps0r4dox7Jd6J5DJLtaauc4wc",
  authDomain: "bitcoingpt.firebaseapp.com",
  projectId: "bitcoingpt",
  storageBucket: "bitcoingpt.firebasestorage.app",
  messagingSenderId: "874396546495",
  appId: "1:874396546495:web:d17fc4c2c6d6ff13ab5d0a",
  measurementId: "G-GMD1FBT818"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
//const analytics = getAnalytics(app);
export const db = getFirestore(app);  // Firestore 초기화 및 내보내기