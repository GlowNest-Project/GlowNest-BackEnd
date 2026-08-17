import { pool, query } from "./db.js";
import { products } from "../../FrontEnd/src/data/products.js";

const NOTE_TYPES = {
  top: "top",
  heart: "heart",
  middle: "middle",
  base: "base",
};

function noteTypeFromLabel(label) {
  const normalized = label.toLowerCase();
  for (const key of Object.keys(NOTE_TYPES)) {
    if (normalized.includes(key)) {
      return NOTE_TYPES[key];
    }
  }
  return "middle";
}

function parseDecant(decant) {
  if (!decant) {
    return { decantSize: null, decantPrice: null };
  }

  const sizeMatch = decant.match(/^([\d.]+\s*mL)/i);
  const priceMatch = decant.match(/LKR\s*([\d,]+)/i);

  return {
    decantSize: sizeMatch ? sizeMatch[1] : null,
    decantPrice: priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : null,
  };
}

async function getCategoryMap() {
  const rows = await query("SELECT id, slug FROM categories");
  return new Map(rows.map((row) => [row.slug, row.id]));
}

async function seedProduct(product, categoryId) {
  const details = product.details || {};
  const { decantSize, decantPrice } = parseDecant(product.decant);
  const slug = product.slug || product.id;

  await query(
    `INSERT INTO products (
      category_id, name, slug, brand, product_type, concentration, gender, volume,
      fragrance_family, release_year, perfumers, shape_hint,
      price_lkr, decant_price_lkr, decant_size, koko_pay_text,
      short_description, detail_description, image_url, detail_image_url,
      stock_quantity, is_featured, is_active
    ) VALUES (
      :categoryId, :name, :slug, :brand, :productType, :concentration, :gender, :volume,
      :fragranceFamily, :releaseYear, :perfumers, :shapeHint,
      :priceLkr, :decantPriceLkr, :decantSize, :kokoPayText,
      :shortDescription, :detailDescription, :imageUrl, :detailImageUrl,
      :stockQuantity, :isFeatured, :isActive
    )
    ON DUPLICATE KEY UPDATE
      category_id = VALUES(category_id),
      name = VALUES(name),
      brand = VALUES(brand),
      product_type = VALUES(product_type),
      concentration = VALUES(concentration),
      gender = VALUES(gender),
      volume = VALUES(volume),
      fragrance_family = VALUES(fragrance_family),
      release_year = VALUES(release_year),
      perfumers = VALUES(perfumers),
      shape_hint = VALUES(shape_hint),
      price_lkr = VALUES(price_lkr),
      decant_price_lkr = VALUES(decant_price_lkr),
      decant_size = VALUES(decant_size),
      koko_pay_text = VALUES(koko_pay_text),
      short_description = VALUES(short_description),
      detail_description = VALUES(detail_description),
      image_url = VALUES(image_url),
      detail_image_url = VALUES(detail_image_url)`,
    {
      categoryId,
      name: product.name,
      slug,
      brand: details.brand || null,
      productType: product.type || "Product",
      concentration: details.concentration || null,
      gender: details.gender || null,
      volume: details.sizes || null,
      fragranceFamily: details.fragranceFamily || null,
      releaseYear: details.releaseYear || null,
      perfumers: details.perfumers || null,
      shapeHint: product.shape || null,
      priceLkr: product.priceValue || 0,
      decantPriceLkr: decantPrice,
      decantSize,
      kokoPayText: product.payment?.text || null,
      shortDescription: product.copy || null,
      detailDescription: details.description || null,
      imageUrl: product.image || null,
      detailImageUrl: product.detailImage || product.image || null,
      stockQuantity: 50,
      isFeatured: false,
      isActive: true,
    }
  );

  const [{ id: productId }] = await query("SELECT id FROM products WHERE slug = :slug", { slug });

  await query("DELETE FROM product_notes WHERE product_id = :productId", { productId });
  await query("DELETE FROM product_accords WHERE product_id = :productId", { productId });
  await query("DELETE FROM product_best_for WHERE product_id = :productId", { productId });
  await query("DELETE FROM product_images WHERE product_id = :productId", { productId });

  const notes = details.notes || [];
  let noteSortOrder = 0;
  for (const note of notes) {
    const noteType = noteTypeFromLabel(note.label || "");
    const names = String(note.value || "")
      .split(/[,/]/)
      .map((name) => name.trim())
      .filter(Boolean);

    for (const noteName of names) {
      await query(
        `INSERT INTO product_notes (product_id, note_type, note_name, sort_order)
         VALUES (:productId, :noteType, :noteName, :sortOrder)`,
        { productId, noteType, noteName, sortOrder: noteSortOrder++ }
      );
    }
  }

  const accords = details.accords || [];
  for (let i = 0; i < accords.length; i++) {
    await query(
      `INSERT INTO product_accords (product_id, accord_name, sort_order)
       VALUES (:productId, :accordName, :sortOrder)`,
      { productId, accordName: accords[i], sortOrder: i }
    );
  }

  const bestFor = details.bestFor || [];
  for (let i = 0; i < bestFor.length; i++) {
    await query(
      `INSERT INTO product_best_for (product_id, occasion, sort_order)
       VALUES (:productId, :occasion, :sortOrder)`,
      { productId, occasion: bestFor[i], sortOrder: i }
    );
  }

  const images = [];
  if (product.image) images.push({ url: product.image, type: "main" });
  if (product.detailImage && product.detailImage !== product.image) {
    images.push({ url: product.detailImage, type: "detail" });
  }

  for (let i = 0; i < images.length; i++) {
    await query(
      `INSERT INTO product_images (product_id, image_url, image_type, sort_order)
       VALUES (:productId, :imageUrl, :imageType, :sortOrder)`,
      { productId, imageUrl: images[i].url, imageType: images[i].type, sortOrder: i }
    );
  }
}

async function seed() {
  const categoryMap = await getCategoryMap();

  for (const product of products) {
    const categoryId = categoryMap.get(product.category);

    if (!categoryId) {
      console.warn(`Skipping "${product.id}": unknown category "${product.category}".`);
      continue;
    }

    await seedProduct(product, categoryId);
  }

  console.log(`Seeded ${products.length} products into glownest_db.`);
  await pool.end();
}

seed().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
