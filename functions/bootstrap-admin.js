const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    throw new Error("Usage: node bootstrap-admin.js <admin-firebase-auth-email>");
  }

  initializeApp({ credential: applicationDefault() });
  const auth = getAuth();
  const existingAdmins = [];
  let pageToken;
  do {
    const users = await auth.listUsers(1000, pageToken);
    existingAdmins.push(...users.users.filter((user) => user.customClaims?.admin === true));
    pageToken = users.pageToken;
  } while (pageToken);
  const target = await auth.getUserByEmail(email);

  if (existingAdmins.some((user) => user.uid !== target.uid)) {
    throw new Error("Another administrator already exists. Refusing to create a second admin.");
  }

  await auth.setCustomUserClaims(target.uid, {
    ...target.customClaims,
    admin: true
  });
  await getFirestore().collection("users").doc(target.uid).set({
    name: "Jeeban",
    email,
    role: "admin",
    area: "Mahendranagar",
    disabled: false
  }, { merge: true });
  console.log(`Administrator role assigned to ${email}. Sign out and sign in again to refresh the ID token.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
