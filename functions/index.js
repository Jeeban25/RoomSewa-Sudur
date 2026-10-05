const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { createHmac, randomUUID } = require("node:crypto");

initializeApp();

const esewaSecret = defineSecret("ESEWA_SECRET_KEY");
const esewaProductCode = defineString("ESEWA_PRODUCT_CODE");
const esewaEnvironment = defineString("ESEWA_ENVIRONMENT", { default: "uat" });
const khaltiSecret = defineSecret("KHALTI_SECRET_KEY");
const publicSiteUrl = defineString("PUBLIC_SITE_URL");
const LISTING_FEE_BPS = 125;
const MIN_GATEWAY_AMOUNT_PAISA = 1001;

function requireAdmin(request) {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }
}

function getListingFeePaisa(monthlyRentNpr) {
  if (!Number.isSafeInteger(monthlyRentNpr) || monthlyRentNpr < 0) {
    throw new HttpsError("invalid-argument", "Monthly rent must be a whole number of NPR greater than or equal to zero.");
  }
  return Math.round(monthlyRentNpr * LISTING_FEE_BPS / 100);
}

function requireOwner(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in as a house owner first.");
}

function isApprovedProfile(profile) {
  return profile.approvalStatus === "approved";
}

function getReturnUrl(paymentId) {
  let base;
  try {
    base = new URL(publicSiteUrl.value());
  } catch {
    throw new HttpsError("failed-precondition", "Set PUBLIC_SITE_URL to the deployed website URL.");
  }
  if (!["https:", "http:"].includes(base.protocol)
    || (base.protocol === "http:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1")) {
    throw new HttpsError("failed-precondition", "PUBLIC_SITE_URL must use HTTPS outside local development.");
  }
  const returnUrl = new URL("/pages/payment-return.html", base);
  returnUrl.searchParams.set("paymentId", paymentId);
  return returnUrl.toString();
}

function formatNpr(paisa) {
  return (paisa / 100).toFixed(2);
}

async function initiateEsewa({ paymentId, feePaisa, returnUrl }) {
  const environment = esewaEnvironment.value();
  if (!["uat", "production"].includes(environment)) {
    throw new HttpsError("failed-precondition", "ESEWA_ENVIRONMENT must be uat or production.");
  }
  const productCode = esewaProductCode.value();
  const secret = esewaSecret.value();
  if (!productCode || !secret) {
    throw new HttpsError("failed-precondition", "Set the eSewa product code and ESEWA_SECRET_KEY.");
  }
  const totalAmount = formatNpr(feePaisa);
  const signedFieldNames = "total_amount,transaction_uuid,product_code";
  const message = `total_amount=${totalAmount},transaction_uuid=${paymentId},product_code=${productCode}`;
  const signature = createHmac("sha256", secret).update(message).digest("base64");
  const action = environment === "production"
    ? "https://epay.esewa.com.np/api/epay/main/v2/form"
    : "https://rc-epay.esewa.com.np/api/epay/main/v2/form";
  return {
    provider: "esewa",
    action,
    fields: {
      amount: totalAmount,
      tax_amount: "0",
      total_amount: totalAmount,
      transaction_uuid: paymentId,
      product_code: productCode,
      product_service_charge: "0",
      product_delivery_charge: "0",
      success_url: returnUrl,
      failure_url: returnUrl,
      signed_field_names: signedFieldNames,
      signature
    },
    transactionUuid: paymentId,
    productCode,
    environment
  };
}

async function initiateKhalti({ paymentId, listingId, feePaisa, returnUrl, owner }) {
  const secret = khaltiSecret.value();
  if (!secret) throw new HttpsError("failed-precondition", "Set the KHALTI_SECRET_KEY.");
  const response = await fetch("https://a.khalti.com/api/v2/epayment/initiate/", {
    method: "POST",
    headers: {
      Authorization: `Key ${secret}`,
      "Content-Type": "application/json"
    },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      return_url: returnUrl,
      website_url: new URL(publicSiteUrl.value()).origin,
      amount: feePaisa,
      purchase_order_id: paymentId,
      purchase_order_name: `Room listing ${listingId}`,
      customer_info: {
        name: owner.name || "House owner",
        email: owner.email || "",
        phone: owner.phone || ""
      }
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.payment_url !== "string" || typeof result.pidx !== "string") {
    throw new HttpsError("unavailable", `Khalti could not start the payment (${response.status}).`);
  }
  return {
    provider: "khalti",
    paymentUrl: result.payment_url,
    pidx: result.pidx,
    transactionUuid: paymentId,
    environment: "production"
  };
}

exports.createListingPayment = onCall({
  region: "asia-south1",
  secrets: [esewaSecret, khaltiSecret]
}, async (request) => {
  requireOwner(request);
  const { listingId, provider } = request.data || {};
  if (typeof listingId !== "string" || !listingId
    || !["esewa", "khalti", "waived"].includes(provider)) {
    throw new HttpsError("invalid-argument", "A listing ID and supported payment method are required.");
  }

  const firestore = getFirestore();
  const listingRef = firestore.collection("listings").doc(listingId);
  const ownerRef = firestore.collection("users").doc(request.auth.uid);
  const paymentRef = firestore.collection("listingPayments").doc();
  const [listingSnapshot, ownerSnapshot] = await Promise.all([listingRef.get(), ownerRef.get()]);
  if (!listingSnapshot.exists
    || listingSnapshot.data().ownerUid !== request.auth.uid
    || listingSnapshot.data().status !== "awaiting_payment"
    || listingSnapshot.data().location !== "Mahendranagar"
    || !Array.isArray(listingSnapshot.data().imageUrls)
    || listingSnapshot.data().imageUrls.length < 2
    || typeof listingSnapshot.data().ownerWhatsapp !== "string"
    || !/^9779\d{9}$/.test(listingSnapshot.data().ownerWhatsapp)) {
    throw new HttpsError("permission-denied", "This listing is not awaiting payment for your account.");
  }
  if (!ownerSnapshot.exists || ownerSnapshot.data().role !== "owner" || ownerSnapshot.data().disabled) {
    throw new HttpsError("permission-denied", "An active house-owner account is required.");
  }
  if (!isApprovedProfile(ownerSnapshot.data())) {
    throw new HttpsError("permission-denied", "An administrator must approve your account first.");
  }

  const rent = listingSnapshot.data().rent;
  if (!Number.isSafeInteger(rent) || rent < 0 || rent > 100000) {
    throw new HttpsError("invalid-argument", "Monthly rent must be between NPR 0 and NPR 100,000.");
  }
  const feePaisa = getListingFeePaisa(rent);
  if (feePaisa < MIN_GATEWAY_AMOUNT_PAISA) {
    if (provider !== "waived") {
      throw new HttpsError("failed-precondition", "This fee is below NPR 10.01 and is waived; submit it without selecting a payment provider.");
    }
    await firestore.runTransaction(async (transaction) => {
      const currentListing = await transaction.get(listingRef);
      if (!currentListing.exists
        || currentListing.data().ownerUid !== request.auth.uid
        || currentListing.data().status !== "awaiting_payment"
        || currentListing.data().rent !== rent
        || ["initiating", "pending"].includes(currentListing.data().paymentStatus)) {
        throw new HttpsError("aborted", "The listing changed. Refresh and try again.");
      }
      transaction.set(paymentRef, {
        listingId,
        ownerUid: request.auth.uid,
        provider: "waived",
        monthlyRentNpr: rent,
        feePaisa,
        currency: "NPR",
        status: "waived",
        waiverReason: "below_gateway_minimum",
        createdAt: new Date()
      });
      transaction.update(listingRef, {
        status: "pending_review",
        paymentStatus: "waived",
        listingFeePaisa: feePaisa,
        paidListingFeePaisa: 0,
        paymentProvider: "waived",
        paymentWaivedReason: "below_gateway_minimum",
        currentPaymentId: paymentRef.id
      });
    });
    return { status: "waived", provider: "waived", paymentId: paymentRef.id };
  }
  if (provider === "waived") {
    throw new HttpsError("failed-precondition", "This fee requires online payment.");
  }
  const transactionUuid = randomUUID();
  await firestore.runTransaction(async (transaction) => {
    const currentListing = await transaction.get(listingRef);
    if (!currentListing.exists
      || currentListing.data().ownerUid !== request.auth.uid
      || currentListing.data().status !== "awaiting_payment"
      || currentListing.data().rent !== rent
      || ["initiating", "pending"].includes(currentListing.data().paymentStatus)) {
      throw new HttpsError("aborted", "The listing changed. Refresh and try again.");
    }
    transaction.set(paymentRef, {
      listingId,
      ownerUid: request.auth.uid,
      provider,
      transactionUuid,
      monthlyRentNpr: rent,
      feePaisa,
      currency: "NPR",
      status: "initiating",
      createdAt: new Date()
    });
    transaction.update(listingRef, {
      listingFeePaisa: feePaisa,
      paymentStatus: "initiating",
      currentPaymentId: paymentRef.id
    });
  });

  try {
    const returnUrl = getReturnUrl(paymentRef.id);
    const initiated = provider === "esewa"
      ? await initiateEsewa({ paymentId: transactionUuid, feePaisa, returnUrl })
      : await initiateKhalti({
        paymentId: transactionUuid,
        listingId,
        feePaisa,
        returnUrl,
        owner: ownerSnapshot.data()
      });
    await paymentRef.update({
      status: "pending",
      transactionUuid,
      ...(provider === "khalti" ? { pidx: initiated.pidx } : {}),
      updatedAt: new Date()
    });
    return { ...initiated, paymentId: paymentRef.id };
  } catch (error) {
    await paymentRef.update({ status: "failed", updatedAt: new Date() });
    const currentListing = await listingRef.get();
    if (currentListing.exists && currentListing.data().currentPaymentId === paymentRef.id) {
      await listingRef.update({ paymentStatus: "failed" });
    }
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("unavailable", `Could not start the payment: ${error.message}`);
  }
});

async function verifyEsewaPayment(payment) {
  const environment = esewaEnvironment.value();
  const productCode = esewaProductCode.value();
  const origin = environment === "production"
    ? "https://esewa.com.np"
    : "https://rc.esewa.com.np";
  const url = new URL("/api/epay/transaction/status/", origin);
  url.searchParams.set("product_code", productCode);
  url.searchParams.set("total_amount", formatNpr(payment.feePaisa));
  url.searchParams.set("transaction_uuid", payment.transactionUuid);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpsError("unavailable", "Could not verify the eSewa payment.");
  if (result.status === "PENDING") return "pending";
  return result.status === "COMPLETE"
    && result.product_code === productCode
    && result.transaction_uuid === payment.transactionUuid
    && Math.round(Number(result.total_amount) * 100) === payment.feePaisa;
}

async function verifyKhaltiPayment(payment) {
  const secret = khaltiSecret.value();
  const response = await fetch("https://a.khalti.com/api/v2/epayment/lookup/", {
    method: "POST",
    headers: {
      Authorization: `Key ${secret}`,
      "Content-Type": "application/json"
    },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ pidx: payment.pidx })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpsError("unavailable", "Could not verify the Khalti payment.");
  if (result.status === "Pending") return "pending";
  return result.status === "Completed"
    && result.pidx === payment.pidx
    && result.purchase_order_id === payment.transactionUuid
    && Number(result.total_amount) === payment.feePaisa;
}

exports.verifyListingPayment = onCall({
  region: "asia-south1",
  secrets: [esewaSecret, khaltiSecret]
}, async (request) => {
  requireOwner(request);
  const { paymentId } = request.data || {};
  if (typeof paymentId !== "string" || !paymentId) {
    throw new HttpsError("invalid-argument", "A payment ID is required.");
  }
  const firestore = getFirestore();
  const ownerProfile = await firestore.collection("users").doc(request.auth.uid).get();
  if (!ownerProfile.exists
    || ownerProfile.data().role !== "owner"
    || ownerProfile.data().disabled
    || !isApprovedProfile(ownerProfile.data())) {
    throw new HttpsError("permission-denied", "An approved, active house-owner account is required.");
  }
  const paymentRef = firestore.collection("listingPayments").doc(paymentId);
  const paymentSnapshot = await paymentRef.get();
  const payment = paymentSnapshot.data();
  if (!paymentSnapshot.exists
    || payment.ownerUid !== request.auth.uid) {
    throw new HttpsError("permission-denied", "This payment does not belong to your account.");
  }
  const listingId = payment.listingId;
  const listingRef = firestore.collection("listings").doc(listingId);
  const listingSnapshot = await listingRef.get();
  if (!listingSnapshot.exists
    || listingSnapshot.data().ownerUid !== request.auth.uid
    || listingSnapshot.data().currentPaymentId !== paymentId) {
    throw new HttpsError("permission-denied", "This payment does not belong to your account.");
  }
  if (payment.status === "paid") return { status: "paid", listingId };
  if (payment.status !== "pending") {
    throw new HttpsError("failed-precondition", "No pending payment is available to verify.");
  }
  const verification = payment.provider === "esewa"
    ? await verifyEsewaPayment(payment)
    : payment.provider === "khalti"
      ? await verifyKhaltiPayment(payment)
      : false;

  if (verification === "pending") return { status: "pending", listingId };
  if (verification !== true) {
    await firestore.runTransaction(async (transaction) => {
      const [currentPayment, currentListing] = await Promise.all([
        transaction.get(paymentRef),
        transaction.get(listingRef)
      ]);
      if (currentPayment.exists && currentPayment.data().status === "pending"
        && currentListing.exists && currentListing.data().currentPaymentId === paymentId) {
        transaction.update(paymentRef, { status: "failed", updatedAt: new Date() });
        transaction.update(listingRef, { paymentStatus: "failed" });
      }
    });
    return { status: "unpaid", listingId, paymentId };
  }

  await firestore.runTransaction(async (transaction) => {
    const [currentPayment, currentListing] = await Promise.all([
      transaction.get(paymentRef),
      transaction.get(listingRef)
    ]);
    if (!currentPayment.exists || !currentListing.exists
      || currentPayment.data().transactionUuid !== payment.transactionUuid
      || currentPayment.data().feePaisa !== payment.feePaisa
      || currentListing.data().ownerUid !== request.auth.uid) {
      throw new HttpsError("aborted", "Payment details changed before verification completed.");
    }
    if (currentPayment.data().status === "paid") return;
    if (currentPayment.data().status !== "pending"
      || currentListing.data().status !== "awaiting_payment"
      || currentListing.data().currentPaymentId !== paymentId) {
      throw new HttpsError("failed-precondition", "The listing is no longer awaiting payment.");
    }
    transaction.update(paymentRef, { status: "paid", verifiedAt: new Date() });
    transaction.update(listingRef, {
      status: "pending_review",
      paymentStatus: "paid",
      paidListingFeePaisa: payment.feePaisa,
      paymentProvider: payment.provider,
      paymentVerifiedAt: new Date()
    });
  });
  return { status: "paid", listingId };
});

exports.approveAccount = onCall({ region: "asia-south1" }, async (request) => {
  requireAdmin(request);
  const { uid } = request.data || {};
  if (typeof uid !== "string" || !uid) {
    throw new HttpsError("invalid-argument", "A user ID is required.");
  }

  try {
    const firestore = getFirestore();
    const profileRef = firestore.collection("users").doc(uid);
    const profile = await profileRef.get();
    if (!profile.exists || !["tenant", "owner"].includes(profile.data().role)) {
      throw new HttpsError("failed-precondition", "Only tenant and house-owner accounts can be approved.");
    }
    const auth = getAuth();
    const target = await auth.getUser(uid);
    if (target.customClaims?.admin === true) {
      throw new HttpsError("failed-precondition", "Administrator accounts must be managed through the trusted Firebase Admin SDK.");
    }
    await auth.updateUser(uid, { disabled: false });
    await profileRef.update({
      approvalStatus: "approved",
      approvedAt: new Date()
    });
    return { uid, approvalStatus: "approved" };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", `Could not approve the account: ${error.message}`);
  }
});

exports.setAccountDisabled = onCall({ region: "asia-south1" }, async (request) => {
  requireAdmin(request);
  const { uid, disabled } = request.data || {};
  if (typeof uid !== "string" || !uid || typeof disabled !== "boolean") {
    throw new HttpsError("invalid-argument", "A user ID and disabled state are required.");
  }
  if (uid === request.auth.uid && disabled) {
    throw new HttpsError("failed-precondition", "The active administrator cannot disable their own account.");
  }

  try {
    const auth = getAuth();
    const target = await auth.getUser(uid);
    if (target.customClaims?.admin === true) {
      throw new HttpsError("failed-precondition", "Administrator accounts must be managed through the trusted Firebase Admin SDK.");
    }
    await auth.updateUser(uid, { disabled });
    await getFirestore().collection("users").doc(uid).set({ disabled }, { merge: true });
    return { uid, disabled };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", `Could not update the account: ${error.message}`);
  }
});

exports.deleteAccount = onCall({ region: "asia-south1" }, async (request) => {
  requireAdmin(request);
  const { uid } = request.data || {};
  if (typeof uid !== "string" || !uid) {
    throw new HttpsError("invalid-argument", "A user ID is required.");
  }
  if (uid === request.auth.uid) {
    throw new HttpsError("failed-precondition", "The active administrator cannot delete their own account.");
  }

  try {
    const target = await getAuth().getUser(uid);
    if (target.customClaims?.admin === true) {
      throw new HttpsError("failed-precondition", "Administrator accounts must be managed through the trusted Firebase Admin SDK.");
    }
    const firestore = getFirestore();
    const ownedListings = await firestore.collection("listings").where("ownerUid", "==", uid).get();
    for (const listing of ownedListings.docs) {
      await getStorage().bucket().deleteFiles({
        prefix: `listings/${uid}/${listing.id}/`
      });
    }
    for (let index = 0; index < ownedListings.docs.length; index += 450) {
      const batch = firestore.batch();
      ownedListings.docs.slice(index, index + 450).forEach((listing) => batch.delete(listing.ref));
      await batch.commit();
    }
    await firestore.collection("users").doc(uid).delete();
    await getAuth().deleteUser(uid);
    return { uid };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", `Could not delete the account: ${error.message}`);
  }
});

exports.deleteListing = onCall({ region: "asia-south1" }, async (request) => {
  requireAdmin(request);
  const { listingId } = request.data || {};
  if (typeof listingId !== "string" || !listingId) {
    throw new HttpsError("invalid-argument", "A listing ID is required.");
  }

  try {
    const firestore = getFirestore();
    const listingRef = firestore.collection("listings").doc(listingId);
    const listing = await listingRef.get();
    if (!listing.exists) return { listingId };
    const ownerUid = listing.data().ownerUid;
    if (typeof ownerUid === "string" && ownerUid) {
      await getStorage().bucket().deleteFiles({
        prefix: `listings/${ownerUid}/${listingId}/`
      });
    }
    await listingRef.delete();
    return { listingId };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", `Could not delete the listing: ${error.message}`);
  }
});
