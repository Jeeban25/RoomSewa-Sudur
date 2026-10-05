import {
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  setPersistence,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytes
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";
import { adminEmail, adminUsername } from "./firebase-config.js";
import { auth, db, firebaseConfigured, functions, storage } from "./firebase-client.js";
import { filterListings } from "./listing-filters.js";

const city = "Mahendranagar";
const cityCenter = [28.9639, 80.1778];
let availableListings = [];
let locationMarker;

function showStatus(element, message, type = "danger") {
  if (!element) return;
  element.className = `alert alert-${type}`;
  element.textContent = message;
}

function showFirebaseSetupNotice() {
  document.querySelectorAll("[data-firebase-setup]").forEach((element) => {
    element.textContent = "Firebase is not configured yet. Add your Firebase web app settings in assets/js/firebase-config.js, then reload this page.";
    element.classList.remove("d-none");
  });
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function busy(form, state) {
  const submitButton = form.querySelector('[type="submit"]');
  if (submitButton) submitButton.disabled = state;
}

function getListingFeePaisa(rent) {
  if (!Number.isSafeInteger(rent) || rent < 0) return 0;
  return Math.round(rent * 125 / 100);
}

function formatNpr(paisa) {
  return `NPR ${(paisa / 100).toLocaleString("en-NP", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function redirectToPayment(payment) {
  if (payment.provider === "khalti") {
    const paymentUrl = new URL(payment.paymentUrl);
    if (paymentUrl.protocol !== "https:"
      || !["pay.khalti.com", "test-pay.khalti.com"].includes(paymentUrl.hostname)) {
      throw new Error("Khalti returned an invalid payment page URL.");
    }
    window.location.assign(paymentUrl.toString());
    return;
  }
  if (payment.provider !== "esewa"
    || !["https://epay.esewa.com.np/api/epay/main/v2/form", "https://rc-epay.esewa.com.np/api/epay/main/v2/form"].includes(payment.action)) {
    throw new Error("eSewa returned an invalid payment form.");
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = payment.action;
  Object.entries(payment.fields).forEach(([name, value]) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = String(value);
    form.append(input);
  });
  document.body.append(form);
  form.submit();
}

async function startListingPayment(listingId, provider) {
  const result = await httpsCallable(functions, "createListingPayment")({ listingId, provider });
  if (result.data.provider !== "waived") redirectToPayment(result.data);
  return result.data;
}

async function registerAccount(form) {
  const status = document.querySelector("[data-form-status]");
  if (!firebaseConfigured) {
    showFirebaseSetupNotice();
    showStatus(status, "Configure Firebase before creating an account.", "warning");
    return;
  }
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  const email = String(data.get("email") || "").trim().toLowerCase();
  const phone = String(data.get("phone") || "").trim();
  const role = String(data.get("role") || "");
  const password = String(data.get("password") || "");
  const confirmation = String(data.get("confirmPassword") || "");

  if (password !== confirmation) {
    showStatus(status, "The passwords do not match.");
    return;
  }
  if (!["tenant", "owner"].includes(role)) {
    showStatus(status, "Choose a valid account type.");
    return;
  }

  busy(form, true);
  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(credential.user, { displayName: name });
    await setDoc(doc(db, "users", credential.user.uid), {
      name,
      email,
      phone,
      role,
      area: city,
      disabled: false,
      createdAt: serverTimestamp()
    });
    window.location.assign(role === "owner" ? "landlord-dashboard.html" : "../index.html");
  } catch (error) {
    showStatus(status, `Account setup failed: ${getErrorMessage(error)}. If the account was created, contact support before trying again.`);
  } finally {
    busy(form, false);
  }
}

async function loginAccount(form) {
  const status = document.querySelector("[data-form-status]");
  if (!firebaseConfigured) {
    showFirebaseSetupNotice();
    showStatus(status, "Configure Firebase before signing in.", "warning");
    return;
  }
  const data = new FormData(form);
  const identifier = String(data.get("identifier") || "").trim();
  const password = String(data.get("password") || "");
  let email = identifier.toLowerCase();
  const isAdminUsername = identifier.toLowerCase() === adminUsername.toLowerCase();

  if (isAdminUsername) {
    if (!adminEmail || adminEmail.startsWith("YOUR_")) {
      showStatus(status, "Set the admin account's Firebase Auth email in assets/js/firebase-config.js before signing in with the admin username.");
      return;
    }
    email = adminEmail.toLowerCase();
  }

  busy(form, true);
  try {
    const persistence = data.get("remember") ? browserLocalPersistence : browserSessionPersistence;
    await setPersistence(auth, persistence);
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const token = await credential.user.getIdTokenResult(true);
    if (isAdminUsername && token.claims.admin !== true) {
      await signOut(auth);
      showStatus(status, "This Firebase account is not authorized as the administrator.");
      return;
    }
    if (token.claims.admin === true) {
      window.location.assign("admin-dashboard.html");
      return;
    }
    const profile = await getDoc(doc(db, "users", credential.user.uid));
    if (!profile.exists()) {
      await signOut(auth);
      showStatus(status, "Your account is missing its profile record. Contact support before continuing.");
      return;
    }
    const returnTo = new URLSearchParams(window.location.search).get("returnTo");
    if (returnTo) {
      const destination = new URL(returnTo, window.location.origin);
      if (destination.origin === window.location.origin
        && destination.pathname.endsWith("/pages/payment-return.html")) {
        window.location.assign(destination.toString());
        return;
      }
    }
    window.location.assign(profile.data().role === "owner" ? "landlord-dashboard.html" : "../index.html");
  } catch (error) {
    showStatus(status, getErrorMessage(error));
  } finally {
    busy(form, false);
  }
}

async function sendResetEmail(form) {
  const status = document.querySelector("[data-form-status]");
  if (!firebaseConfigured) {
    showFirebaseSetupNotice();
    showStatus(status, "Configure Firebase before requesting a password reset.", "warning");
    return;
  }
  const identifier = String(new FormData(form).get("identifier") || "").trim().toLowerCase();
  const email = identifier === adminUsername.toLowerCase() ? adminEmail.toLowerCase() : identifier;
  if (!email || email.startsWith("your_")) {
    showStatus(status, "Set the admin account's Firebase Auth email in assets/js/firebase-config.js before requesting a reset by username.");
    return;
  }
  busy(form, true);
  try {
    await sendPasswordResetEmail(auth, email);
    showStatus(status, "If an account exists for that email, Firebase has sent a password reset link.", "success");
  } catch (error) {
    showStatus(status, getErrorMessage(error));
  } finally {
    busy(form, false);
  }
}

function makeListingCard(listing, id) {
  const column = document.createElement("div");
  column.className = "col-md-6 col-lg-4";
  const card = document.createElement("article");
  card.className = "room-card h-100";

  const makeImageFallback = () => {
    const fallback = document.createElement("div");
    fallback.className = "room-card-image-fallback";
    fallback.setAttribute("aria-hidden", "true");
    const icon = document.createElement("i");
    icon.className = "bi bi-house-door";
    fallback.append(icon);
    return fallback;
  };

  const media = document.createElement("div");
  media.className = "room-card-media";
  const imageUrl = Array.isArray(listing.imageUrls) ? listing.imageUrls[0] : "";
  if (typeof imageUrl === "string" && imageUrl.trim()) {
    const image = document.createElement("img");
    image.className = "room-card-img";
    image.src = imageUrl;
    image.alt = listing.title ? `Photo of ${listing.title}` : "Room in Mahendranagar";
    image.loading = "lazy";
    image.addEventListener("error", () => {
      image.replaceWith(makeImageFallback());
    }, { once: true });
    media.append(image);
  } else {
    media.append(makeImageFallback());
  }

  const type = document.createElement("span");
  type.className = "room-card-type";
  type.textContent = listing.type || "Room";
  media.append(type);

  const body = document.createElement("div");
  body.className = "room-card-body";
  const location = document.createElement("p");
  location.className = "room-card-location";
  const locationIcon = document.createElement("i");
  locationIcon.className = "bi bi-geo-alt";
  locationIcon.setAttribute("aria-hidden", "true");
  location.append(locationIcon, document.createTextNode(` ${listing.area ? `${listing.area}, ` : ""}${city}`));
  const title = document.createElement("h3");
  title.className = "room-card-title";
  title.textContent = listing.title || "Room listing";
  const description = document.createElement("p");
  description.className = "room-card-description";
  const listingDescription = typeof listing.description === "string" ? listing.description.trim() : "";
  description.textContent = listingDescription
    ? `${listingDescription.slice(0, 112)}${listingDescription.length > 112 ? "…" : ""}`
    : "View room details and contact the house owner.";

  const amenities = document.createElement("div");
  amenities.className = "room-card-amenities";
  (Array.isArray(listing.amenities) ? listing.amenities : []).slice(0, 3).forEach((amenity) => {
    const chip = document.createElement("span");
    chip.className = "room-card-amenity";
    chip.textContent = amenity;
    amenities.append(chip);
  });

  const availability = document.createElement("span");
  availability.className = "room-card-availability";
  if (listing.availableFrom) {
    const availableDate = new Date(listing.availableFrom);
    if (!Number.isNaN(availableDate.getTime())) {
      availability.textContent = `Available ${availableDate.toLocaleDateString("en-NP", {
        day: "numeric",
        month: "short",
        year: "numeric"
      })}`;
    }
  }

  const footer = document.createElement("div");
  footer.className = "room-card-footer";
  const rent = document.createElement("div");
  rent.className = "room-card-rent";
  const price = document.createElement("span");
  price.className = "room-card-price";
  const monthlyRent = Number(listing.rent);
  price.textContent = Number.isFinite(monthlyRent) ? `NPR ${monthlyRent.toLocaleString("en-IN")}` : "Rent on request";
  const rentPeriod = document.createElement("span");
  rentPeriod.className = "room-card-rent-period";
  rentPeriod.textContent = Number.isFinite(monthlyRent) ? "per month" : "";
  rent.append(price, rentPeriod);
  const link = document.createElement("a");
  link.className = "room-card-link";
  const detailsPath = window.location.pathname.includes("/pages/")
    ? "room-details.html"
    : "pages/room-details.html";
  link.href = `${detailsPath}?id=${encodeURIComponent(id)}`;
  link.setAttribute("aria-label", `View details for ${listing.title || "room listing"}`);
  link.innerHTML = 'View room <i class="bi bi-arrow-right" aria-hidden="true"></i>';
  footer.append(rent, link);
  body.append(location, title, description);
  if (amenities.childElementCount) body.append(amenities);
  if (availability.textContent) body.append(availability);
  body.append(footer);
  card.append(media, body);
  column.append(card);
  return column;
}

async function loadListings(container, featured = false) {
  const status = document.querySelector("[data-listing-status]");
  if (!firebaseConfigured) {
    if (status) showStatus(status, "Configure Firebase to load current room listings.", "warning");
    return;
  }

  try {
    const snapshot = await getDocs(query(
      collection(db, "listings"),
      where("location", "==", city),
      where("status", "==", "approved")
    ));
    availableListings = snapshot.docs
      .map((listingDoc) => ({ id: listingDoc.id, ...listingDoc.data() }))
      .filter((listing) => listing.location === city);
    if (featured) {
      renderListings(container, availableListings.slice(0, 3));
    } else {
      applyListingFilters();
    }
    if (!availableListings.length && status) {
      showStatus(status, "There are no approved room listings in Mahendranagar yet.", "info");
    } else if (featured && status) {
      status.classList.add("d-none");
    }
  } catch (error) {
    if (status) showStatus(status, `Could not load room listings: ${getErrorMessage(error)}`);
  }
}

function renderListings(container, listings) {
  container.replaceChildren();
  listings.forEach((listing) => container.append(makeListingCard(listing, listing.id)));
}

function applyListingFilters() {
  const container = document.querySelector("[data-listings]");
  if (!container) return;
  const filterForm = document.getElementById("listingFilters");
  const range = document.getElementById("priceRange");
  const filtered = filterListings(availableListings, {
    types: Array.from(filterForm?.querySelectorAll('[name="type"]:checked') || [], (input) => input.value),
    amenities: Array.from(filterForm?.querySelectorAll('[name="amenity"]:checked') || [], (input) => input.value),
    area: filterForm?.elements.area?.value,
    keyword: filterForm?.elements.keyword?.value,
    minRent: filterForm?.elements.minRent?.value,
    maxRent: range ? range.value : Infinity,
    sort: document.querySelector("[data-listing-sort]")?.value
  });
  renderListings(container, filtered);
  const status = document.querySelector("[data-listing-status]");
  const count = document.querySelector("[data-listing-count]");
  if (count) {
    count.textContent = `${filtered.length} ${filtered.length === 1 ? "room" : "rooms"}`;
  }
  if (status) {
    if (filtered.length) status.classList.add("d-none");
    else showStatus(status, availableListings.length
      ? "No rooms match those filters. Try widening your area or rent range, or clear the filters."
      : "There are no approved room listings in Mahendranagar yet.", "info");
  }
}

function updateRentRangeOutput() {
  const range = document.getElementById("priceRange");
  const output = range?.closest(".mb-3")?.querySelector("output");
  if (range && output) {
    output.value = `NPR ${Number(range.value).toLocaleString("en-IN")}`;
  }
}

function restoreListingFiltersFromUrl() {
  const form = document.getElementById("listingFilters");
  if (!form) return;
  const params = new URLSearchParams(window.location.search);
  for (const requestedType of params.getAll("type")) {
    const typeInput = Array.from(form.querySelectorAll('[name="type"]'))
      .find((input) => input.value === requestedType);
    if (typeInput) typeInput.checked = true;
  }
  for (const [parameter, selector] of [["minRent", '[name="minRent"]'], ["maxRent", "#priceRange"]]) {
    const input = form.querySelector(selector);
    const value = Number(params.get(parameter));
    if (input && params.has(parameter) && value >= Number(input.min || 0)) {
      input.value = String(Math.min(value, Number(input.max)));
    }
  }
  const sort = params.get("sort");
  const sortSelect = document.querySelector("[data-listing-sort]");
  if (sort && sortSelect && Array.from(sortSelect.options).some((option) => option.value === sort)) {
    sortSelect.value = sort;
  }
  const areaInput = form.querySelector('[name="area"]');
  const keywordInput = form.querySelector('[name="keyword"]');
  if (areaInput) areaInput.value = params.get("area") || "";
  if (keywordInput) keywordInput.value = params.get("keyword") || "";
  const selectedAmenities = new Set(params.getAll("amenity"));
  form.querySelectorAll('[name="amenity"]').forEach((input) => {
    input.checked = selectedAmenities.has(input.value);
  });
  updateRentRangeOutput();
}

function updateFilterUrl() {
  if (!document.getElementById("listingFilters")) return;
  const params = new URLSearchParams();
  const form = document.getElementById("listingFilters");
  const area = String(form.elements.area?.value || "").trim();
  const keyword = String(form.elements.keyword?.value || "").trim();
  const minRent = form.elements.minRent?.value;
  const maxRent = document.getElementById("priceRange")?.value;
  if (area) params.set("area", area);
  if (keyword) params.set("keyword", keyword);
  if (minRent) params.set("minRent", minRent);
  if (maxRent && Number(maxRent) < Number(document.getElementById("priceRange").max)) {
    params.set("maxRent", maxRent);
  }
  form.querySelectorAll('[name="type"]:checked').forEach((input) => params.append("type", input.value));
  form.querySelectorAll('[name="amenity"]:checked').forEach((input) => params.append("amenity", input.value));
  const sort = document.querySelector("[data-listing-sort]")?.value;
  if (sort && sort !== "Price: Low to High") params.set("sort", sort);
  const queryString = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${queryString ? `?${queryString}` : ""}`);
}

async function submitListing(form) {
  const status = document.querySelector("[data-form-status]");
  if (!firebaseConfigured) {
    showFirebaseSetupNotice();
    showStatus(status, "Configure Firebase before submitting a listing.", "warning");
    return;
  }
  const data = new FormData(form);
  const files = Array.from(form.querySelector('[name="photos"]').files || []);
  if (files.length < 2) {
    showStatus(status, "Upload at least two room photos.");
    return;
  }
  if (files.length > 8) {
    showStatus(status, "Upload no more than eight photos.");
    return;
  }
  if (files.some((file) => !file.type.startsWith("image/") || file.size > 5 * 1024 * 1024)) {
    showStatus(status, "Every file must be an image no larger than 5MB.");
    return;
  }
  if (!auth.currentUser) {
    showStatus(status, "Sign in with a room-owner account before posting a room.");
    return;
  }
  const whatsapp = String(data.get("ownerWhatsapp") || "").replace(/\D/g, "");
  const localWhatsapp = whatsapp.startsWith("977") ? whatsapp.slice(3) : whatsapp;
  if (!/^9\d{9}$/.test(localWhatsapp)) {
    showStatus(status, "Enter a valid Nepal mobile WhatsApp number (for example 98XXXXXXXX).");
    return;
  }
  const rent = Number(data.get("rent"));
  if (!Number.isSafeInteger(rent) || rent < 0 || rent > 100000) {
    showStatus(status, "Monthly rent must be a whole amount between NPR 0 and NPR 100,000.");
    return;
  }
  const latitude = Number(data.get("latitude"));
  const longitude = Number(data.get("longitude"));
  if (latitude < 28.8 || latitude > 29.1 || longitude < 80 || longitude > 80.35) {
    showStatus(status, "Choose a point inside the Mahendranagar map area.");
    return;
  }

  busy(form, true);
  const uploadedImageRefs = [];
  let listingCreated = false;
  let imagesReady = false;
  let listingSubmitted = false;
  let listingId;
  try {
    const profile = await getDoc(doc(db, "users", auth.currentUser.uid));
    if (!profile.exists() || !["owner"].includes(profile.data().role)) {
      throw new Error("Only registered room owners can post a listing.");
    }
    const listingRef = doc(collection(db, "listings"));
    listingId = listingRef.id;
    await setDoc(listingRef, {
      title: String(data.get("title")).trim(),
      description: String(data.get("description")).trim(),
      type: String(data.get("type")),
      rent: Number(data.get("rent")),
      availableFrom: String(data.get("availableFrom")),
      amenities: data.getAll("amenities").map(String),
      area: String(data.get("area") || "").trim(),
      location: city,
      latitude,
      longitude,
      ownerUid: auth.currentUser.uid,
      ownerName: profile.data().name,
      ownerWhatsapp: localWhatsapp.startsWith("977") ? localWhatsapp : `977${localWhatsapp}`,
      imageUrls: [],
      status: "awaiting_payment",
      paymentStatus: "awaiting_payment",
      createdAt: serverTimestamp()
    });
    listingCreated = true;
    const imageUrls = [];
    for (const [index, file] of files.entries()) {
      const extension = file.name.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "") || "jpg";
      const imageRef = ref(storage, `listings/${auth.currentUser.uid}/${listingRef.id}/${index}.${extension}`);
      await uploadBytes(imageRef, file, { contentType: file.type });
      uploadedImageRefs.push(imageRef);
      imageUrls.push(await getDownloadURL(imageRef));
    }
    await updateDoc(listingRef, { imageUrls });
    imagesReady = true;
    const provider = getListingFeePaisa(rent) < 1001
      ? "waived"
      : String(data.get("paymentProvider"));
    const payment = await startListingPayment(listingId, provider);
    if (payment.status === "waived") {
      listingSubmitted = true;
      showStatus(status, "Your listing was submitted for review. The fee is below NPR 10.01, so no payment was charged.", "success");
    }
  } catch (error) {
    if (listingCreated && imagesReady) {
      showStatus(status, `Your draft is saved. Payment could not start: ${getErrorMessage(error)}. Open the House Owner Dashboard to retry payment.`);
    } else {
      const cleanupResults = await Promise.allSettled([
        ...uploadedImageRefs.map(deleteObject),
        ...(listingCreated ? [deleteDoc(doc(db, "listings", listingId))] : [])
      ]);
      const cleanupFailures = cleanupResults.filter((result) => result.status === "rejected").length;
      const cleanupNote = cleanupFailures
        ? ` Cleanup also failed for ${cleanupFailures} uploaded file(s).`
        : "";
      showStatus(status, `Could not save your room: ${getErrorMessage(error)}.${cleanupNote}`);
    }
  } finally {
    busy(form, listingSubmitted);
  }
}

async function loadRoomDetails() {
  const container = document.querySelector("[data-room-details]");
  if (!container) return;
  const status = document.querySelector("[data-room-status]");
  if (!firebaseConfigured) {
    if (status) showStatus(status, "Configure Firebase to view current room details.", "warning");
    return;
  }
  const id = new URLSearchParams(window.location.search).get("id");
  if (!id) {
    if (status) showStatus(status, "Choose a room from the Mahendranagar listings.");
    return;
  }
  try {
    const snapshot = await getDoc(doc(db, "listings", id));
    if (!snapshot.exists()
      || snapshot.data().status !== "approved"
      || snapshot.data().location !== city) {
      throw new Error("This listing is unavailable.");
    }
    const listing = snapshot.data();
    container.classList.remove("d-none");
    document.querySelector("[data-room-title]").textContent = listing.title;
    document.querySelector("[data-room-type]").textContent = listing.type || "Room";
    document.querySelector("[data-room-location]").textContent = listing.area ? `${listing.area}, ${city}` : city;
    document.querySelector("[data-room-rent]").textContent = `NPR ${Number(listing.rent).toLocaleString("en-IN")}`;
    document.querySelector("[data-room-description]").textContent = listing.description || "Contact the owner to confirm the room details and availability.";
    document.querySelector("[data-room-owner]").textContent = listing.ownerName || "Room owner";
    const gallery = document.querySelector("[data-room-gallery]");
    gallery.replaceChildren();
    (listing.imageUrls || []).forEach((url, index) => {
      const column = document.createElement("div");
      column.className = index === 0 ? "col-md-8" : "col-6 col-md-4";
      const image = document.createElement("img");
      image.src = url;
      image.alt = listing.title;
      image.className = "img-fluid rounded-3 object-fit-cover w-100";
      image.style.height = index === 0 ? "380px" : "180px";
      column.append(image);
      gallery.append(column);
    });
    const amenities = document.querySelector("[data-room-amenities]");
    amenities.replaceChildren();
    (listing.amenities || []).forEach((amenity) => {
      const item = document.createElement("div");
      item.className = "col-6 col-md-4";
      item.textContent = amenity;
      amenities.append(item);
    });
    if (listing.ownerWhatsapp) {
      const whatsappNumber = String(listing.ownerWhatsapp).replace(/\D/g, "");
      const whatsappLink = document.querySelector("[data-room-whatsapp]");
      whatsappLink.href = `https://wa.me/${whatsappNumber}`;
      whatsappLink.classList.remove("d-none");
    } else {
      document.querySelector("[data-room-whatsapp]").classList.add("d-none");
    }
    if (window.L && Number.isFinite(Number(listing.latitude)) && Number.isFinite(Number(listing.longitude))) {
      const map = window.L.map("roomMap").setView([Number(listing.latitude), Number(listing.longitude)], 15);
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);
      window.L.marker([Number(listing.latitude), Number(listing.longitude)]).addTo(map).bindPopup(city).openPopup();
    }
    if (status) status.classList.add("d-none");
  } catch (error) {
    if (status) showStatus(status, getErrorMessage(error));
  }
}

function startLocationPicker() {
  const mapElement = document.getElementById("listingMap");
  if (!mapElement || !window.L) return;
  const latitude = document.getElementById("listingLatitude");
  const longitude = document.getElementById("listingLongitude");
  const markerPosition = [...cityCenter];
  latitude.value = markerPosition[0];
  longitude.value = markerPosition[1];
  const map = window.L.map(mapElement).setView(markerPosition, 14);
  map.setMaxBounds([[28.8, 80.0], [29.1, 80.35]]);
  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  locationMarker = window.L.marker(markerPosition, { draggable: true }).addTo(map);
  const updateLocation = (position) => {
    latitude.value = position.lat;
    longitude.value = position.lng;
  };
  map.on("click", (event) => {
    locationMarker.setLatLng(event.latlng);
    updateLocation(event.latlng);
  });
  locationMarker.on("dragend", (event) => updateLocation(event.target.getLatLng()));
}

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

async function loadAdminData() {
  const usersBody = document.querySelector("[data-admin-users]");
  const listingsBody = document.querySelector("[data-admin-listings]");
  const status = document.querySelector("[data-admin-status]");
  try {
    const [usersSnapshot, listingsSnapshot] = await Promise.all([
      getDocs(collection(db, "users")),
      getDocs(collection(db, "listings"))
    ]);
    document.querySelector("[data-admin-user-count]").textContent = usersSnapshot.size;
    const cityListings = listingsSnapshot.docs.filter((listing) => listing.data().location === city);
    document.querySelector("[data-admin-listing-count]").textContent = cityListings.length;
    usersBody.replaceChildren();
    listingsBody.replaceChildren();

    usersSnapshot.forEach((userSnapshot) => {
      const user = userSnapshot.data();
      const row = document.createElement("tr");
      row.append(element("td", user.name || "—"), element("td", user.email || "—"));
      const roleCell = document.createElement("td");
      if (user.role === "admin") {
        roleCell.textContent = "Administrator";
      } else {
        const roleSelect = document.createElement("select");
        roleSelect.className = "form-select form-select-sm";
        for (const [value, label] of [["tenant", "Student"], ["owner", "Room owner"]]) {
          const option = element("option", label);
          option.value = value;
          roleSelect.append(option);
        }
        roleSelect.value = user.role;
        roleSelect.addEventListener("change", async () => {
          roleSelect.disabled = true;
          try {
            await updateDoc(doc(db, "users", userSnapshot.id), { role: roleSelect.value });
            await loadAdminData();
          } catch (error) {
            showStatus(status, `Could not update user role: ${getErrorMessage(error)}`);
            roleSelect.disabled = false;
            roleSelect.value = user.role;
          }
        });
        roleCell.append(roleSelect);
      }
      row.append(roleCell, element("td", user.phone || "—"));
      const actionCell = document.createElement("td");
      if (user.role === "admin") {
        actionCell.textContent = "Manage through trusted Firebase Admin SDK";
        row.append(actionCell);
        usersBody.append(row);
        return;
      }
      const accountButton = element("button", user.disabled ? "Enable" : "Disable");
      accountButton.type = "button";
      accountButton.className = "btn btn-sm btn-outline-secondary me-2";
      accountButton.addEventListener("click", async () => {
        accountButton.disabled = true;
        try {
          await httpsCallable(functions, "setAccountDisabled")({
            uid: userSnapshot.id,
            disabled: !user.disabled
          });
          await loadAdminData();
        } catch (error) {
          showStatus(status, `Could not update account: ${getErrorMessage(error)}`);
          accountButton.disabled = false;
        }
      });
      const deleteButton = element("button", "Delete");
      deleteButton.type = "button";
      deleteButton.className = "btn btn-sm btn-outline-danger";
      deleteButton.addEventListener("click", async () => {
        if (!window.confirm(`Permanently delete ${user.email || "this user"}?`)) return;
        deleteButton.disabled = true;
        try {
          await httpsCallable(functions, "deleteAccount")({ uid: userSnapshot.id });
          await loadAdminData();
        } catch (error) {
          showStatus(status, `Could not delete account: ${getErrorMessage(error)}`);
          deleteButton.disabled = false;
        }
      });
      actionCell.append(accountButton, deleteButton);
      row.append(actionCell);
      usersBody.append(row);
    });

    cityListings.forEach((listingSnapshot) => {
      const listing = listingSnapshot.data();
      const row = document.createElement("tr");
      for (const value of [listing.title || "Untitled", listing.location || city, listing.ownerName || "—", listing.status || "pending"]) {
        row.append(element("td", value));
      }
      const actionCell = document.createElement("td");
      const approveButton = element("button", "Approve");
      approveButton.type = "button";
      approveButton.className = "btn btn-sm btn-success me-2";
      approveButton.disabled = !["paid", "waived"].includes(listing.paymentStatus);
      approveButton.addEventListener("click", async () => {
        try {
          await updateDoc(doc(db, "listings", listingSnapshot.id), { status: "approved" });
          await loadAdminData();
        } catch (error) {
          showStatus(status, `Could not approve listing: ${getErrorMessage(error)}`);
        }
      });
      const rejectButton = element("button", "Reject");
      rejectButton.type = "button";
      rejectButton.className = "btn btn-sm btn-outline-secondary me-2";
      rejectButton.addEventListener("click", async () => {
        try {
          await updateDoc(doc(db, "listings", listingSnapshot.id), { status: "rejected" });
          await loadAdminData();
        } catch (error) {
          showStatus(status, `Could not reject listing: ${getErrorMessage(error)}`);
        }
      });
      const deleteButton = element("button", "Delete");
      deleteButton.type = "button";
      deleteButton.className = "btn btn-sm btn-outline-danger";
      deleteButton.addEventListener("click", async () => {
        if (!window.confirm(`Permanently delete "${listing.title || "this listing"}"?`)) return;
        try {
          await httpsCallable(functions, "deleteListing")({ listingId: listingSnapshot.id });
          await loadAdminData();
        } catch (error) {
          showStatus(status, `Could not delete listing: ${getErrorMessage(error)}`);
        }
      });
      row.append(element("td", `${listing.paymentStatus || "unpaid"} · ${listing.paymentProvider || "—"} · ${listing.listingFeePaisa ? formatNpr(listing.listingFeePaisa) : "—"}`));
      actionCell.append(approveButton, rejectButton, deleteButton);
      row.append(actionCell);
      listingsBody.append(row);
    });
    status.classList.add("d-none");
  } catch (error) {
    showStatus(status, `Could not load admin data: ${getErrorMessage(error)}`);
  }
}

function startOwnerDashboard() {
  const dashboard = document.querySelector("[data-owner-dashboard]");
  if (!dashboard) return;
  const status = document.querySelector("[data-owner-status]");
  if (!firebaseConfigured) {
    showFirebaseSetupNotice();
    showStatus(status, "Configure Firebase before managing your listings.", "warning");
    return;
  }
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.replace("login.html");
      return;
    }
    try {
      const profile = await getDoc(doc(db, "users", user.uid));
      if (!profile.exists() || profile.data().role !== "owner") {
        showStatus(status, "A room-owner account is required to open this dashboard.");
        return;
      }
      document.querySelector("[data-owner-name]").textContent = profile.data().name || user.email;
      const snapshot = await getDocs(query(
        collection(db, "listings"),
        where("ownerUid", "==", user.uid),
        where("location", "==", city)
      ));
      await renderOwnerListings(snapshot, user.uid);
      document.querySelector("[data-owner-count]").textContent = snapshot.size;
      if (!snapshot.size) showStatus(status, "You have not submitted any room listings yet.", "info");
      else status.classList.add("d-none");
    } catch (error) {
      showStatus(status, `Could not load your listings: ${getErrorMessage(error)}`);
    }
  });
  document.querySelector("[data-owner-signout]").addEventListener("click", async () => {
    try {
      await signOut(auth);
      window.location.replace("login.html");
    } catch (error) {
      showStatus(status, `Could not sign out: ${getErrorMessage(error)}`);
    }
  });
}

async function renderOwnerListings(snapshot, uid) {
  const status = document.querySelector("[data-owner-status]");
  const container = document.querySelector("[data-owner-listings]");
  container.replaceChildren();
  snapshot.forEach((listingSnapshot) => {
        const listing = listingSnapshot.data();
        const row = document.createElement("tr");
        for (const value of [
          listing.title || "Untitled",
          listing.location || city,
          `NPR ${Number(listing.rent || 0).toLocaleString("en-IN")}/month`,
          `${listing.status || "pending"} · ${listing.paymentStatus || "unpaid"}`
        ]) {
          row.append(element("td", value));
        }
        const actionCell = document.createElement("td");
        if (listing.status === "awaiting_payment"
          && ["initiating", "pending"].includes(listing.paymentStatus)) {
          const verifyButton = element("button", "Check payment");
          verifyButton.type = "button";
          verifyButton.className = "btn btn-sm btn-outline-secondary";
          verifyButton.addEventListener("click", async () => {
            verifyButton.disabled = true;
            try {
              const result = await httpsCallable(functions, "verifyListingPayment")({
                paymentId: listing.currentPaymentId
              });
              showStatus(status, result.data.status === "paid"
                ? "Payment confirmed. Your listing is now awaiting review."
                : "The gateway has not confirmed payment yet. Check again shortly.", result.data.status === "paid" ? "success" : "info");
              await loadOwnerListings(uid);
            } catch (error) {
              showStatus(status, `Could not verify payment: ${getErrorMessage(error)}`);
              verifyButton.disabled = false;
            }
          });
          actionCell.append(verifyButton);
        } else if (listing.status === "awaiting_payment") {
          for (const [provider, label] of [["esewa", "Pay with eSewa"], ["khalti", "Pay with Khalti"]]) {
            const paymentButton = element("button", label);
            paymentButton.type = "button";
            paymentButton.className = "btn btn-sm btn-outline-primary me-2 mb-1";
            paymentButton.addEventListener("click", async () => {
              paymentButton.disabled = true;
              try {
                await startListingPayment(listingSnapshot.id, provider);
              } catch (error) {
                showStatus(status, `Could not start payment: ${getErrorMessage(error)}`);
                paymentButton.disabled = false;
              }
            });
            actionCell.append(paymentButton);
          }
        }
        row.append(actionCell);
        container.append(row);
  });
  document.querySelector("[data-owner-count]").textContent = snapshot.size;
}

async function loadOwnerListings(uid) {
  const snapshot = await getDocs(query(
    collection(db, "listings"),
    where("ownerUid", "==", uid),
    where("location", "==", city)
  ));
  await renderOwnerListings(snapshot, uid);
}

function startPaymentReturn() {
  const page = document.querySelector("[data-payment-return]");
  if (!page) return;
  const status = document.querySelector("[data-payment-return-status]");
  const loginLink = document.querySelector("[data-payment-return-login]");
  const paymentId = new URLSearchParams(window.location.search).get("paymentId");
  if (!paymentId) {
    showStatus(status, "The payment reference is missing. Open your House Owner Dashboard to check the listing.", "warning");
    return;
  }
  if (!firebaseConfigured) {
    showFirebaseSetupNotice();
    showStatus(status, "Configure Firebase to securely verify this payment.", "warning");
    return;
  }
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      const returnTo = encodeURIComponent(window.location.href);
      loginLink.href = `login.html?returnTo=${returnTo}`;
      loginLink.classList.remove("d-none");
      showStatus(status, "Sign in as the house owner to verify the payment with the gateway.", "warning");
      return;
    }
    loginLink.classList.add("d-none");
    showStatus(status, "Verifying your payment directly with the payment provider…", "info");
    try {
      const result = await httpsCallable(functions, "verifyListingPayment")({ paymentId });
      if (result.data.status === "paid") {
        showStatus(status, "Payment confirmed. Your listing is now waiting for review.", "success");
      } else if (result.data.status === "pending") {
        showStatus(status, "The payment provider has not confirmed this transaction yet. Check your House Owner Dashboard again shortly.", "warning");
      } else {
        showStatus(status, "The payment was not confirmed. You can retry from your House Owner Dashboard.", "danger");
      }
    } catch (error) {
      showStatus(status, `Could not verify payment: ${getErrorMessage(error)}`);
    }
  });
}

function startProfileForm() {
  const form = document.querySelector("#profileForm");
  if (!form) return;
  const status = document.querySelector("[data-profile-status]");
  if (!firebaseConfigured) {
    showFirebaseSetupNotice();
    showStatus(status, "Configure Firebase before editing your profile.", "warning");
    return;
  }
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.replace("login.html");
      return;
    }
    try {
      const profile = await getDoc(doc(db, "users", user.uid));
      if (!profile.exists()) throw new Error("The account profile could not be found.");
      form.querySelector('[name="name"]').value = profile.data().name || "";
      form.querySelector('[name="phone"]').value = profile.data().phone || "";
      form.querySelector('[name="email"]').value = user.email || "";
    } catch (error) {
      showStatus(status, `Could not load your profile: ${getErrorMessage(error)}`);
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const user = auth.currentUser;
    if (!user) {
      showStatus(status, "Sign in again to update your profile.");
      return;
    }
    busy(form, true);
    try {
      await updateDoc(doc(db, "users", user.uid), {
        name: String(form.querySelector('[name="name"]').value).trim(),
        phone: String(form.querySelector('[name="phone"]').value).trim()
      });
      await updateProfile(user, { displayName: String(form.querySelector('[name="name"]').value).trim() });
      showStatus(status, "Profile updated.", "success");
    } catch (error) {
      showStatus(status, `Could not update your profile: ${getErrorMessage(error)}`);
    } finally {
      busy(form, false);
    }
  });
  document.querySelector("[data-profile-signout]")?.addEventListener("click", async () => {
    try {
      await signOut(auth);
      window.location.replace("login.html");
    } catch (error) {
      showStatus(status, `Could not sign out: ${getErrorMessage(error)}`);
    }
  });
}

function startAdminDashboard() {
  if (!document.querySelector("[data-admin-dashboard]")) return;
  const status = document.querySelector("[data-admin-status]");
  if (!firebaseConfigured) {
    showFirebaseSetupNotice();
    showStatus(status, "Configure Firebase before opening the admin dashboard.", "warning");
    return;
  }
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.replace("login.html");
      return;
    }
    try {
      const token = await user.getIdTokenResult(true);
      if (token.claims.admin !== true) {
        await signOut(auth);
        window.location.replace("login.html");
        return;
      }
      document.querySelector("[data-admin-email]").textContent = user.email || adminUsername;
      await loadAdminData();
    } catch (error) {
      showStatus(status, `Could not verify admin access: ${getErrorMessage(error)}`);
    }
  });
  document.querySelector("[data-admin-signout]").addEventListener("click", async () => {
    try {
      await signOut(auth);
      window.location.replace("login.html");
    } catch (error) {
      showStatus(status, `Could not sign out: ${getErrorMessage(error)}`);
    }
  });
}

if (!firebaseConfigured) showFirebaseSetupNotice();

document.querySelectorAll("[data-password-toggle]").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const input = document.getElementById(toggle.dataset.passwordToggle);
    if (!(input instanceof HTMLInputElement)) return;
    const isVisible = input.type === "text";
    input.type = isVisible ? "password" : "text";
    toggle.setAttribute("aria-pressed", String(!isVisible));
    toggle.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
    const icon = toggle.querySelector("i");
    if (icon) icon.className = isVisible ? "bi bi-eye" : "bi bi-eye-slash";
  });
});

document.querySelector("#registerForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  registerAccount(event.currentTarget);
});
document.querySelector("#loginForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  loginAccount(event.currentTarget);
});
document.querySelector("#forgotPasswordForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  sendResetEmail(event.currentTarget);
});
document.querySelector("#listingForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitListing(event.currentTarget);
});
const rentInput = document.querySelector("#listingRent");
const feeOutput = document.querySelector("[data-listing-fee]");
function updateListingFeeDisplay() {
  if (!rentInput || !feeOutput) return;
  const rent = Number(rentInput.value);
  const feePaisa = Number.isSafeInteger(rent) && rent >= 0 ? getListingFeePaisa(rent) : 0;
  feeOutput.textContent = rentInput.value !== "" && Number.isSafeInteger(rent)
    ? formatNpr(getListingFeePaisa(rent))
    : "NPR 0.00";
  const feeNote = document.querySelector("[data-fee-note]");
  const paymentOptions = document.querySelector("[data-payment-options]");
  const submitLabel = document.querySelector("[data-submit-label]");
  const waived = feePaisa < 1001;
  if (feeNote) {
    feeNote.textContent = rentInput.value === ""
      ? "The listing fee is 1.25% of one month's rent."
      : waived
        ? "Fees below NPR 10.01 are waived because the gateways cannot process them."
        : "Choose eSewa or Khalti to pay this fee securely.";
  }
  paymentOptions?.classList.toggle("d-none", waived);
  if (submitLabel) {
    submitLabel.textContent = rentInput.value === ""
      ? "Enter rent to continue"
      : waived
        ? "Submit room for review"
        : "Continue to secure payment";
  }
}
rentInput?.addEventListener("input", updateListingFeeDisplay);
updateListingFeeDisplay();

document.querySelectorAll("[data-gallery-image]").forEach((thumb) => {
  thumb.addEventListener("click", () => {
    const mainImage = document.getElementById("mainGalleryImg");
    if (mainImage) mainImage.src = thumb.dataset.galleryImage;
  });
});
const listingContainer = document.querySelector("[data-listings]");
if (listingContainer) loadListings(listingContainer);
const featuredContainer = document.querySelector("[data-featured-listings]");
if (featuredContainer) loadListings(featuredContainer, true);
loadRoomDetails();
startLocationPicker();
startAdminDashboard();
startOwnerDashboard();
startProfileForm();
startPaymentReturn();
restoreListingFiltersFromUrl();

const filters = document.getElementById("listingFilters");
filters?.addEventListener("submit", (event) => {
  event.preventDefault();
  applyListingFilters();
  updateFilterUrl();
});
filters?.addEventListener("reset", () => window.setTimeout(() => {
  updateRentRangeOutput();
  const sort = document.querySelector("[data-listing-sort]");
  if (sort) sort.value = "Price: Low to High";
  applyListingFilters();
  updateFilterUrl();
}, 0));
filters?.addEventListener("input", (event) => {
  if (event.target.matches("#priceRange")) updateRentRangeOutput();
  applyListingFilters();
  updateFilterUrl();
});
filters?.addEventListener("change", (event) => {
  if (event.target.matches("#priceRange")) updateRentRangeOutput();
  applyListingFilters();
  updateFilterUrl();
});
document.querySelector("[data-listing-sort]")?.addEventListener("change", () => {
  applyListingFilters();
  updateFilterUrl();
});
