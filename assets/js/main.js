import { formatCurrency } from './modules/utils.js';
import { fetchListings } from './modules/api.js';

document.addEventListener('DOMContentLoaded', () => {
  console.log('RoomSewa-Sudur app initialized.');

  // Initialize event listeners
  const searchForm = document.getElementById('search-form');
  if (searchForm) {
    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      alert('Search triggered!');
    });
  }
});