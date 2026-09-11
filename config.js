/* Firebase config — MUST match the user app's config.js exactly */
const firebaseConfig = {
  apiKey: "AIzaSyBHRGu8LA3T6xkggR5q-_rnTR6yKwdlYlk",
  authDomain: "godxinvest-7daeb.firebaseapp.com",
  databaseURL: "https://godxinvest-7daeb-default-rtdb.firebaseio.com",
  projectId: "godxinvest-7daeb",
  storageBucket: "godxinvest-7daeb.firebasestorage.app",
  messagingSenderId: "728078321044",
  appId: "1:728078321044:web:b109517408d9230767fb81",
  measurementId: "G-E34DH2G1XM"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
