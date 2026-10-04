/**
 * Fetch room listings from backend API
 */
export async function fetchListings() {
  try {
    // Replace with real endpoint later
    const response = await fetch('/api/rooms');
    if (!response.ok) throw new Error('Failed to fetch listings');
    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    return [];
  }
}