// Canned API payloads, shaped like the real /api responses
// (see assets/data/products-snapshot.json for the live format).

export const PRODUCTS = [
  {
    id: 'prod_small', name: 'Small', priceId: 'price_small', unitAmount: 3000, currency: 'gbp',
    sizeCode: '500', frameKey: 'small', displaySize: '20cm x 20cm', aspectRatio: 1, sortOrder: 1,
  },
  {
    id: 'prod_medium', name: 'Medium', priceId: 'price_medium', unitAmount: 3500, currency: 'gbp',
    sizeCode: '750', frameKey: 'medium', displaySize: 'A4', aspectRatio: 1.4, sortOrder: 2,
  },
  {
    id: 'prod_large', name: 'Large', priceId: 'price_large', unitAmount: 4500, currency: 'gbp',
    sizeCode: '2000', frameKey: 'large', displaySize: '32cm x 32cm', aspectRatio: 1, sortOrder: 5,
  },
];

const frames = (key, amount) => [
  { productId: `fprod_${key}_oak`, priceId: `fprice_${key}_oak`, unitAmount: amount, frameKey: key, colourHex: '#D8B589', colourName: 'Oak' },
  { productId: `fprod_${key}_black`, priceId: `fprice_${key}_black`, unitAmount: amount, frameKey: key, colourHex: '#000000', colourName: 'Black' },
  { productId: `fprod_${key}_white`, priceId: `fprice_${key}_white`, unitAmount: amount, frameKey: key, colourHex: '#FFFFFF', colourName: 'White' },
];

export const FRAME_PRICES = {
  small: frames('small', 1000),
  medium: frames('medium', 1500),
  large: frames('large', 2200),
};

export const PRODUCTS_RESPONSE = { products: PRODUCTS, framePrices: FRAME_PRICES };

export const PLACES = [
  {
    name: 'Edinburgh Old Town', description: 'The castle rock and the Royal Mile.', size: 'large', frame: 'oak',
    lat: 55.9486, lng: -3.1999, zoom: 15,
    image: { url: '/assets/imgs/Large%20frame.webp', alt: 'Edinburgh sculpture', width: 800, height: 800 },
  },
  {
    name: 'Bath', description: '', size: 'custom', widthCm: 25, heightCm: 18,
    lat: 51.3811, lng: -2.359, zoom: 16,
    image: { url: '/assets/imgs/custom.webp' },
  },
];

export const review = (n, extra = {}) => ({
  name: `Reviewer ${n}`, location: 'Leeds, UK', rating: 5, title: `Title ${n}`, body: `Body ${n}`,
  createdAt: '2026-09-01', ...extra,
});

export const NOMINATIM = [
  { display_name: 'Whitby, North Yorkshire, England', lat: '54.4863', lon: '-0.6133' },
  { display_name: 'Whitby, Ontario, Canada', lat: '43.8975', lon: '-78.9429' },
  { display_name: 'Whitby Abbey, England', lat: '54.4886', lon: '-0.6077' },
];
