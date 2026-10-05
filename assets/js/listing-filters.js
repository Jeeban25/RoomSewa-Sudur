function normalize(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function getCreatedAt(listing) {
  const createdAt = listing.createdAt;
  if (typeof createdAt?.seconds === "number") return createdAt.seconds;
  if (createdAt instanceof Date) return createdAt.getTime() / 1000;
  return 0;
}

export function filterListings(listings, filters = {}) {
  const selectedTypes = new Set(filters.types || []);
  const selectedAmenities = filters.amenities || [];
  const minRent = Number.isFinite(Number(filters.minRent)) ? Number(filters.minRent) : 0;
  const maxRent = Number.isFinite(Number(filters.maxRent)) ? Number(filters.maxRent) : Infinity;
  const area = normalize(filters.area);
  const keyword = normalize(filters.keyword);
  const sort = filters.sort || "Price: Low to High";

  const filtered = listings.filter((listing) => {
    const rent = Number(listing.rent);
    if (!Number.isFinite(rent) || rent < minRent || rent > maxRent) return false;
    if (selectedTypes.size && !selectedTypes.has(listing.type)) return false;

    const listingAmenities = Array.isArray(listing.amenities) ? listing.amenities : [];
    if (!selectedAmenities.every((amenity) => listingAmenities.includes(amenity))) return false;

    const searchableText = normalize([
      listing.title,
      listing.description,
      listing.type,
      listing.area,
      listing.location,
      ...listingAmenities
    ].join(" "));
    if (area && !normalize([listing.area, listing.location].join(" ")).includes(area)) return false;
    if (keyword && !keyword.split(/\s+/).every((term) => searchableText.includes(term))) return false;
    return true;
  });

  if (sort === "Price: Low to High") filtered.sort((a, b) => Number(a.rent) - Number(b.rent));
  if (sort === "Price: High to Low") filtered.sort((a, b) => Number(b.rent) - Number(a.rent));
  if (sort === "Most Recent") filtered.sort((a, b) => getCreatedAt(b) - getCreatedAt(a));
  return filtered;
}
