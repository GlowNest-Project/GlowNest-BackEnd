import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adminQuery, ensureAdminDatabase } from "./admin-db.js";
import { query } from "./db.js";
import { sendEmailVerificationOtp } from "./mailer.js";
import { sendPhoneVerificationOtp } from "./sms.js";

const PORT = Number(process.env.PORT || 4000);
const AUTH_SECRET = process.env.AUTH_SECRET || "glownest-local-secret";
let adminSchemaReady = false;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://127.0.0.1:3005";
const PUBLIC_API_ORIGIN = process.env.PUBLIC_API_ORIGIN || `http://127.0.0.1:${PORT}`;
const PAYHERE_MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID || "";
const PAYHERE_MERCHANT_SECRET = process.env.PAYHERE_MERCHANT_SECRET || "";
const PAYHERE_SANDBOX = process.env.PAYHERE_SANDBOX !== "false";
const PAYHERE_CHECKOUT_URL = PAYHERE_SANDBOX
  ? "https://sandbox.payhere.lk/pay/checkout"
  : "https://www.payhere.lk/pay/checkout";
const OTP_DEV_MODE = process.env.OTP_DEV_MODE !== "false";
const OTP_EXPIRY_MS = Number(process.env.OTP_EXPIRY_MINUTES || 10) * 60 * 1000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCT_UPLOAD_DIR = join(__dirname, "..", "..", "FrontEnd", "public", "uploads", "products");
const PRODUCT_UPLOAD_URL = "/uploads/products";
const signupOtpSessions = new Map();
const accountOtpSessions = new Map();

function cleanupAccountOtpSessions() {
  const now = Date.now();
  for (const [key, session] of accountOtpSessions.entries()) {
    if (session.expiresAt < now) {
      accountOtpSessions.delete(key);
    }
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
      }
    });

    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });

    request.on("error", reject);
  });
}

function readFormBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
      }
    });

    request.on("end", () => {
      const params = new URLSearchParams(body);
      resolve(Object.fromEntries(params.entries()));
    });

    request.on("error", reject);
  });
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;

      if (size > 8_000_000) {
        reject(new Error("Image is too large. Please upload an image under 8MB."));
      }
    });

    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function parseMultipartImage(request, bodyBuffer) {
  const contentType = request.headers["content-type"] || "";
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];

  if (!boundary) {
    throw new Error("Upload boundary was not found.");
  }

  const boundaryText = `--${boundary}`;
  const body = bodyBuffer.toString("latin1");
  const parts = body.split(boundaryText).slice(1, -1);

  for (const part of parts) {
    const cleanPart = part.startsWith("\r\n") ? part.slice(2) : part;
    const headerEnd = cleanPart.indexOf("\r\n\r\n");

    if (headerEnd === -1) {
      continue;
    }

    const headers = cleanPart.slice(0, headerEnd);
    const content = cleanPart.slice(headerEnd + 4, cleanPart.endsWith("\r\n") ? -2 : undefined);
    const filename = headers.match(/filename="([^"]+)"/)?.[1];
    const mimeType = headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || "";

    if (!filename) {
      continue;
    }

    return {
      filename,
      mimeType,
      buffer: Buffer.from(content, "latin1"),
    };
  }

  throw new Error("Image file was not found in the upload.");
}

async function saveUploadedProductImage(upload) {
  if (!upload.mimeType.startsWith("image/")) {
    throw new Error("Please upload an image file.");
  }

  const extension = extname(upload.filename).toLowerCase() || ".png";
  const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

  if (!allowedExtensions.has(extension)) {
    throw new Error("Please upload JPG, PNG, WEBP, or GIF images only.");
  }

  await mkdir(PRODUCT_UPLOAD_DIR, { recursive: true });

  const fileName = `product-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${extension}`;
  await writeFile(join(PRODUCT_UPLOAD_DIR, fileName), upload.buffer);

  return `${PRODUCT_UPLOAD_URL}/${fileName}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120_000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  const [salt, originalHash] = storedPassword.split(":");
  const nextHash = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(originalHash), Buffer.from(nextHash));
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/g, "");
}

function createOtpCode() {
  return String(crypto.randomInt(100000, 999999));
}

function hashOtp(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function safeOtpMatch(code, hashedCode) {
  const nextHash = hashOtp(code);
  return crypto.timingSafeEqual(Buffer.from(nextHash), Buffer.from(hashedCode));
}

function createSignupOtpSession(userInput) {
  const verificationId = crypto.randomBytes(18).toString("hex");
  const emailOtp = createOtpCode();
  const phoneOtp = createOtpCode();
  const expiresAt = Date.now() + OTP_EXPIRY_MS;

  signupOtpSessions.set(verificationId, {
    userInput,
    emailOtpHash: hashOtp(emailOtp),
    phoneOtpHash: hashOtp(phoneOtp),
    attempts: 0,
    expiresAt,
  });

  return { verificationId, emailOtp, phoneOtp, expiresAt, userInput };
}

function cleanupSignupOtpSessions() {
  const now = Date.now();

  for (const [verificationId, session] of signupOtpSessions.entries()) {
    if (session.expiresAt < now) {
      signupOtpSessions.delete(verificationId);
    }
  }
}

async function sendSignupOtp({ email, phone, emailOtp, phoneOtp, name }) {
  try {
    await sendEmailVerificationOtp({
      to: email,
      otpCode: emailOtp,
      name: name || "Customer",
    });
  } catch (error) {
    console.error(`[GlowNest Mailer Error] Failed to send email OTP to ${email}:`, error?.message || error);
  }

  try {
    await sendPhoneVerificationOtp({
      phone,
      otpCode: phoneOtp,
    });
  } catch (error) {
    console.error(`[GlowNest SMS Error] Failed to send phone OTP to ${phone}:`, error?.message || error);
  }

  if (OTP_DEV_MODE) {
    console.log(`[GlowNest OTP - Dev Log] Email ${email}: ${emailOtp}`);
    console.log(`[GlowNest OTP - Dev Log] Phone ${phone}: ${phoneOtp}`);
  }
}

function createToken(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, createdAt: Date.now() })).toString("base64url");
  const signature = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function createAdminToken(adminId) {
  const payload = Buffer.from(JSON.stringify({ adminId, role: "admin", createdAt: Date.now() })).toString("base64url");
  const signature = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readToken(request) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token.includes(".")) {
    return null;
  }

  const [payload, signature] = token.split(".");
  const expectedSignature = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");

  if (signature !== expectedSignature) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function publicUser(user) {
  const isEmailVerified = Boolean(user.is_email_verified || user.email_verified_at);
  const isPhoneVerified = Boolean(user.is_phone_verified || user.phone_verified_at);
  return {
    id: user.id,
    name: user.full_name,
    phone: user.phone,
    email: user.email,
    role: user.role,
    isEmailVerified,
    isPhoneVerified,
    isVerified: isEmailVerified && isPhoneVerified,
    emailVerifiedAt: user.email_verified_at || null,
    phoneVerifiedAt: user.phone_verified_at || null,
    createdAt: user.created_at,
  };
}

function publicAdmin(admin) {
  return {
    id: admin.id,
    name: admin.full_name,
    phone: admin.phone || "",
    email: admin.email,
    role: "admin",
    createdAt: admin.created_at,
  };
}

async function ensureAdminTable() {
  if (adminSchemaReady) {
    return;
  }

  await ensureAdminDatabase();

  try {
    const [legacyTable] = await query(
      `SELECT 1 AS table_exists
       FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'admin_users'
       LIMIT 1`
    );

    if (legacyTable) {
      const legacyAdmins = await query(
        `SELECT full_name, phone, email, password_hash, status, created_at, updated_at
         FROM admin_users`
      );

      for (const admin of legacyAdmins) {
        await adminQuery(
          `INSERT INTO admin_users
            (full_name, phone, email, password_hash, status, created_at, updated_at)
           VALUES
            (:fullName, :phone, :email, :passwordHash, :status, :createdAt, :updatedAt)
           ON DUPLICATE KEY UPDATE
            full_name = VALUES(full_name),
            phone = VALUES(phone),
            password_hash = VALUES(password_hash),
            status = VALUES(status),
            updated_at = VALUES(updated_at)`,
          {
            fullName: admin.full_name,
            phone: admin.phone || null,
            email: admin.email,
            passwordHash: admin.password_hash,
            status: admin.status || "active",
            createdAt: admin.created_at,
            updatedAt: admin.updated_at,
          }
        );
      }
    }
  } catch (error) {
    console.warn(`[GlowNest Admin DB] Legacy migration skipped: ${error.message}`);
  }

  adminSchemaReady = true;
}

async function getCurrentUser(request) {
  const tokenPayload = readToken(request);

  if (!tokenPayload?.userId) {
    return null;
  }

  const [user] = await query("SELECT * FROM users WHERE id = :id", { id: tokenPayload.userId });
  return user || null;
}

async function getCurrentAdmin(request) {
  const tokenPayload = readToken(request);

  if (tokenPayload?.adminId) {
    await ensureAdminTable();
    const [admin] = await adminQuery(
      "SELECT * FROM admin_users WHERE id = :id AND status = 'active'",
      { id: tokenPayload.adminId }
    );
    return admin || null;
  }

  return null;
}

async function requireAdmin(request, response) {
  const admin = await getCurrentAdmin(request);

  if (!admin) {
    sendJson(response, 401, { error: "Admin login is required." });
    return null;
  }

  return admin;
}

const NOTE_LABELS = {
  top: "Top Notes",
  heart: "Heart Notes",
  middle: "Middle Notes",
  base: "Base Notes",
};

function mapProductRow(row) {
  const isCosmetic = row.category_slug === "cosmetics";
  const discountType = row.discount_type === "fixed_amount" ? "fixed_amount" : "percentage";
  const discountTarget = isCosmetic
    ? "full"
    : ["full", "decant", "both"].includes(row.discount_target)
      ? row.discount_target
      : "both";
  const discountPercent = Number(row.discount_percent || 0);
  const discountAmount = Number(row.discount_amount_lkr || 0);
  const discountValue = discountType === "fixed_amount" ? discountAmount : discountPercent;
  const discountStartAt = row.discount_start_at || null;
  const discountEndAt = row.discount_end_at || null;
  const now = Date.now();
  const startsAt = discountStartAt ? new Date(discountStartAt).getTime() : null;
  const endsAt = discountEndAt ? new Date(discountEndAt).getTime() : null;
  const isDiscountActive =
    discountValue > 0 &&
    Number.isFinite(startsAt) &&
    Number.isFinite(endsAt) &&
    now >= startsAt &&
    now < endsAt;
  const discountEnabled =
    discountValue > 0 && Number.isFinite(startsAt) && Number.isFinite(endsAt) && now < endsAt;
  const fullBottlePrice = Number(row.price_lkr);
  const decantPrice = row.decant_price_lkr != null ? Number(row.decant_price_lkr) : null;
  const applyDiscount = (price, option) => {
    const appliesToOption = discountTarget === "both" || discountTarget === option;
    if (!isDiscountActive || !appliesToOption) return price;
    return discountType === "fixed_amount"
      ? Math.max(0, price - discountAmount)
      : Math.round((price * (100 - discountPercent)) / 100);
  };

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category_slug,
    brand: row.brand,
    type: row.product_type,
    concentration: row.concentration,
    gender: row.gender,
    volume: row.volume,
    keyIngredients: row.key_ingredients,
    mainBenefits: row.main_benefits,
    skinType: row.skin_type,
    skinConcerns: row.skin_concerns,
    howToUse: row.how_to_use,
    shape: row.shape_hint,
    priceValue: applyDiscount(fullBottlePrice, "full"),
    originalPriceValue: fullBottlePrice,
    discountType,
    discountTarget,
    discountPercent,
    discountAmount,
    discountStartAt,
    discountEndAt,
    discountEnabled,
    isDiscountActive,
    decant:
      !isCosmetic && row.decant_price_lkr != null
        ? {
            size: row.decant_size,
            priceValue: applyDiscount(decantPrice, "decant"),
            originalPriceValue: decantPrice,
          }
        : null,
    kokoPay: row.koko_pay_text,
    shortDescription: row.short_description,
    image: row.image_url,
    popImage: row.pop_image_url || null,
    stockQuantity: Number(row.stock_quantity || 0),
    isInStock: Number(row.stock_quantity || 0) > 0,
    isActive: Boolean(row.is_active),
  };
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function uniqueProductSlug(name, existingId) {
  const baseSlug = slugify(name) || `product-${Date.now()}`;
  let slug = baseSlug;
  let suffix = 2;

  while (true) {
    const [existingProduct] = await query(
      "SELECT id FROM products WHERE slug = :slug AND (:existingId IS NULL OR id <> :existingId)",
      { slug, existingId: existingId || null }
    );

    if (!existingProduct) {
      return slug;
    }

    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}

async function productInput(body, existingId = null) {
  const categorySlug = String(body.category || "").trim();
  const isCosmetic = categorySlug === "cosmetics";
  const name = String(body.name || "").trim();
  const priceValue = Number(body.priceValue);
  const decantPriceValue = !isCosmetic && body.decantPriceValue ? Number(body.decantPriceValue) : null;
  const discountType = body.discountType === "fixed_amount" ? "fixed_amount" : "percentage";
  const discountTarget = isCosmetic
    ? "full"
    : ["full", "decant", "both"].includes(body.discountTarget)
      ? body.discountTarget
      : "both";
  const discountPercent = Number(body.discountPercent || 0);
  const discountAmount = Number(body.discountAmount || 0);
  const requestedDiscountValue = discountType === "fixed_amount" ? discountAmount : discountPercent;
  const discountEnabled = body.discountEnabled !== false && body.discountEnabled !== "false";
  const discountValue = discountEnabled ? requestedDiscountValue : 0;
  const discountStartDate = String(body.discountStartAt || "").trim().slice(0, 10) || null;
  const discountEndDate = String(body.discountEndAt || "").trim().slice(0, 10) || null;

  if (!["perfumes", "cosmetics"].includes(categorySlug)) {
    return { error: "Choose perfumes or cosmetics." };
  }

  if (name.length < 2) {
    return { error: "Product name is required." };
  }

  if (!Number.isFinite(priceValue) || priceValue <= 0) {
    return { error: isCosmetic ? "Valid price is required." : "Valid full bottle price is required." };
  }

  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent >= 100) {
    return { error: "Discount must be between 0 and 99 percent." };
  }

  if (!Number.isFinite(discountAmount) || discountAmount < 0) {
    return { error: "Discount amount must be zero or more." };
  }

  if (discountEnabled && discountValue <= 0) {
    return { error: "Enter a discount percentage or amount." };
  }

  if (discountValue > 0 && discountTarget === "decant" && !decantPriceValue) {
    return { error: "Add a decant price before scheduling a decant discount." };
  }

  const targetPrices = [
    ...(discountTarget !== "decant" ? [priceValue] : []),
    ...(discountTarget !== "full" && decantPriceValue ? [decantPriceValue] : []),
  ];
  const lowestProductPrice = Math.min(...targetPrices);
  if (discountType === "fixed_amount" && discountAmount >= lowestProductPrice) {
    return { error: "Fixed discount amount must be less than every available item price." };
  }

  if (discountValue > 0) {
    if (!discountStartDate || !discountEndDate) {
      return { error: "Choose both the first and last discount day." };
    }

    if (discountEndDate < discountStartDate) {
      return { error: "The last discount day cannot be before the first day." };
    }
  }

  const endDateParts = discountEndDate?.split("-").map(Number);
  const exclusiveEndDate = endDateParts
    ? new Date(endDateParts[0], endDateParts[1] - 1, endDateParts[2] + 1)
    : null;
  const formatLocalDate = (date) =>
    date
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
          date.getDate()
        ).padStart(2, "0")}`
      : null;

  const [category] = await query("SELECT id FROM categories WHERE slug = :slug LIMIT 1", {
    slug: categorySlug,
  });

  if (!category) {
    return { error: "Product category was not found." };
  }

  return {
    categoryId: category.id,
    name,
    slug: await uniqueProductSlug(name, existingId),
    brand: String(body.brand || "").trim() || null,
    type: String(body.type || (categorySlug === "perfumes" ? "Perfume" : "Cosmetic")).trim(),
    concentration: isCosmetic ? null : String(body.concentration || "").trim() || null,
    gender: String(body.gender || "").trim() || null,
    volume: String(body.volume || "").trim() || null,
    fragranceFamily: isCosmetic ? null : String(body.fragranceFamily || "").trim() || null,
    releaseYear: isCosmetic ? null : String(body.releaseYear || "").trim() || null,
    perfumers: isCosmetic ? null : String(body.perfumers || "").trim() || null,
    keyIngredients: isCosmetic ? String(body.keyIngredients || "").trim() || null : null,
    mainBenefits: isCosmetic ? String(body.mainBenefits || "").trim() || null : null,
    skinType: isCosmetic ? String(body.skinType || "").trim() || null : null,
    skinConcerns: isCosmetic ? String(body.skinConcerns || "").trim() || null : null,
    howToUse: isCosmetic ? String(body.howToUse || "").trim() || null : null,
    priceValue,
    discountType: discountValue > 0 ? discountType : "percentage",
    discountTarget: discountValue > 0 ? discountTarget : isCosmetic ? "full" : "both",
    discountPercent: discountType === "percentage" ? discountPercent : 0,
    discountAmount: discountType === "fixed_amount" ? discountAmount : 0,
    discountStartAt: discountValue > 0 ? `${discountStartDate} 00:00:00` : null,
    discountEndAt: discountValue > 0 ? `${formatLocalDate(exclusiveEndDate)} 00:00:00` : null,
    decantPriceValue,
    decantSize: isCosmetic ? null : String(body.decantSize || "10mL").trim() || "10mL",
    kokoPay: String(body.kokoPay || "").trim() || null,
    shortDescription: String(body.shortDescription || "").trim() || null,
    detailDescription: String(body.detailDescription || "").trim() || null,
    image: String(body.image || "").trim() || null,
    detailImage: String(body.detailImage || "").trim() || null,
    popImage: String(body.popImage || "").trim() || null,
    stockQuantity: body.stockStatus === "out_of_stock" ? 0 : Math.max(1, Number(body.stockQuantity || 1)),
    isActive: body.isActive !== false,
    topNotes: isCosmetic ? [] : splitList(body.topNotes),
    heartNotes: isCosmetic ? [] : splitList(body.heartNotes),
    baseNotes: isCosmetic ? [] : splitList(body.baseNotes),
    accords: isCosmetic ? [] : splitList(body.accords),
    bestFor: isCosmetic ? [] : splitList(body.bestFor),
  };
}

async function replaceProductDetails(productId, input) {
  await query("DELETE FROM product_notes WHERE product_id = :productId", { productId });
  await query("DELETE FROM product_accords WHERE product_id = :productId", { productId });
  await query("DELETE FROM product_best_for WHERE product_id = :productId", { productId });
  await query("DELETE FROM product_images WHERE product_id = :productId", { productId });

  const noteGroups = [
    ["top", input.topNotes],
    ["heart", input.heartNotes],
    ["base", input.baseNotes],
  ];
  let noteOrder = 1;

  for (const [noteType, notes] of noteGroups) {
    for (const noteName of notes) {
      await query(
        `INSERT INTO product_notes (product_id, note_type, note_name, sort_order)
         VALUES (:productId, :noteType, :noteName, :sortOrder)`,
        { productId, noteType, noteName, sortOrder: noteOrder }
      );
      noteOrder += 1;
    }
  }

  let accordOrder = 1;
  for (const accord of input.accords) {
    await query(
      `INSERT INTO product_accords (product_id, accord_name, sort_order)
       VALUES (:productId, :accordName, :sortOrder)`,
      { productId, accordName: accord, sortOrder: accordOrder }
    );
    accordOrder += 1;
  }

  let bestForOrder = 1;
  for (const occasion of input.bestFor) {
    await query(
      `INSERT INTO product_best_for (product_id, occasion, sort_order)
       VALUES (:productId, :occasion, :sortOrder)`,
      { productId, occasion, sortOrder: bestForOrder }
    );
    bestForOrder += 1;
  }

  if (input.image) {
    await query(
      `INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order)
       VALUES (:productId, :imageUrl, :altText, 'main', 1)`,
      { productId, imageUrl: input.image, altText: input.name }
    );
  }

  if (input.detailImage && input.detailImage !== input.image) {
    await query(
      `INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order)
       VALUES (:productId, :imageUrl, :altText, 'detail', 2)`,
      { productId, imageUrl: input.detailImage, altText: `${input.name} details` }
    );
  }

  if (input.popImage && input.popImage !== input.image && input.popImage !== input.detailImage) {
    await query(
      `INSERT INTO product_images (product_id, image_url, alt_text, image_type, sort_order)
       VALUES (:productId, :imageUrl, :altText, 'gallery', 99)`,
      { productId, imageUrl: input.popImage, altText: `${input.name} pop out` }
    );
  }
}

async function getAdminProductList() {
  const rows = await query(
    `SELECT p.*, c.slug AS category_slug FROM products p
     JOIN categories c ON c.id = p.category_id
     WHERE c.slug IN ('perfumes', 'cosmetics')
     ORDER BY p.updated_at DESC, p.id DESC`
  );

  return Promise.all(rows.map((row) => getProductDetail(row.slug)));
}

function groupNotes(notes) {
  const order = [];
  const grouped = new Map();

  for (const note of notes) {
    if (!grouped.has(note.note_type)) {
      grouped.set(note.note_type, []);
      order.push(note.note_type);
    }
    grouped.get(note.note_type).push(note.note_name);
  }

  return order.map((type) => ({
    label: NOTE_LABELS[type] || "Notes",
    value: grouped.get(type).join(", "),
  }));
}

async function getProductList(url) {
  const category = url.searchParams.get("category");
  const rows = category
    ? await query(
        `SELECT p.*, c.slug AS category_slug,
           (
             SELECT pi.image_url
             FROM product_images pi
             WHERE pi.product_id = p.id AND pi.image_type = 'gallery' AND pi.sort_order = 99
             LIMIT 1
           ) AS pop_image_url
         FROM products p
         JOIN categories c ON c.id = p.category_id
         WHERE p.is_active = 1 AND c.slug = :category
         ORDER BY p.id`,
        { category }
      )
    : await query(
        `SELECT p.*, c.slug AS category_slug,
           (
             SELECT pi.image_url
             FROM product_images pi
             WHERE pi.product_id = p.id AND pi.image_type = 'gallery' AND pi.sort_order = 99
             LIMIT 1
           ) AS pop_image_url
         FROM products p
         JOIN categories c ON c.id = p.category_id
         WHERE p.is_active = 1
         ORDER BY p.id`
      );

  return rows.map(mapProductRow);
}

async function getProductDetail(slug) {
  const [row] = await query(
    `SELECT p.*, c.slug AS category_slug FROM products p
     JOIN categories c ON c.id = p.category_id
     WHERE p.slug = :slug OR p.id = :slug
     LIMIT 1`,
    { slug }
  );

  if (!row) {
    return null;
  }

  const [notes, accords, bestFor, images] = await Promise.all([
    query(
      "SELECT note_type, note_name FROM product_notes WHERE product_id = :id ORDER BY sort_order",
      { id: row.id }
    ),
    query(
      "SELECT accord_name FROM product_accords WHERE product_id = :id ORDER BY sort_order",
      { id: row.id }
    ),
    query(
      "SELECT occasion FROM product_best_for WHERE product_id = :id ORDER BY sort_order",
      { id: row.id }
    ),
    query(
      "SELECT image_url, image_type, sort_order FROM product_images WHERE product_id = :id ORDER BY sort_order",
      { id: row.id }
    ),
  ]);

  return {
    ...mapProductRow(row),
    detailImage: row.detail_image_url,
    popImage:
      images.find((image) => image.image_type === "gallery" && Number(image.sort_order) === 99)
        ?.image_url || null,
    detailDescription: row.detail_description,
    fragranceFamily: row.fragrance_family,
    releaseYear: row.release_year,
    perfumers: row.perfumers,
    notes: groupNotes(notes),
    accords: accords.map((accord) => accord.accord_name),
    bestFor: bestFor.map((item) => item.occasion),
    images: images.map((image) => ({ url: image.image_url, type: image.image_type })),
  };
}

function mapOrderItem(row) {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    productSlug: row.product_slug,
    quantity: Number(row.quantity || 0),
    unitPrice: Number(row.unit_price_lkr || 0),
    lineTotal: Number(row.line_total_lkr || 0),
  };
}

const ORDER_STATUS_DETAILS = {
  new: {
    title: "Order received",
    message: "Your order has been received by GlowNest.",
  },
  confirmed: {
    title: "Order received",
    message: "Your order has been received and is being prepared.",
  },
  packed: {
    title: "Order packed",
    message: "Your order is packed and ready for delivery.",
  },
  delivered: {
    title: "Order delivered",
    message: "Your GlowNest order has been delivered.",
  },
  cancelled: {
    title: "Order cancelled",
    message: "Your order was cancelled. Please contact GlowNest if you need help.",
  },
};

const PAYMENT_STATUS_DETAILS = {
  pending: {
    title: "Payment pending",
    message: "Your order payment is still pending.",
  },
  paid: {
    title: "Payment received",
    message: "Your order payment has been received.",
  },
  failed: {
    title: "Payment failed",
    message: "Your order payment was unsuccessful. Please contact GlowNest if you need help.",
  },
  refunded: {
    title: "Payment refunded",
    message: "Your order payment has been refunded.",
  },
};

function statusDetails(status, orderNumber) {
  const details = ORDER_STATUS_DETAILS[status] || ORDER_STATUS_DETAILS.new;

  return {
    title: details.title,
    message: orderNumber ? `${details.message} Order ${orderNumber}.` : details.message,
  };
}

async function ensureOrderNotificationTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS order_status_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      order_id BIGINT UNSIGNED NOT NULL,
      status ENUM('new','confirmed','packed','delivered','cancelled') NOT NULL,
      note VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY order_status_history_order_id_index (order_id),
      CONSTRAINT order_status_history_order_id_foreign
        FOREIGN KEY (order_id) REFERENCES orders(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS customer_notifications (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      order_id BIGINT UNSIGNED NULL,
      notification_type VARCHAR(60) NOT NULL DEFAULT 'order_status',
      title VARCHAR(120) NOT NULL,
      message VARCHAR(255) NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY customer_notifications_user_id_index (user_id),
      KEY customer_notifications_order_id_index (order_id),
      KEY customer_notifications_is_read_index (is_read),
      CONSTRAINT customer_notifications_user_id_foreign
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
      CONSTRAINT customer_notifications_order_id_foreign
        FOREIGN KEY (order_id) REFERENCES orders(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS admin_notifications (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      order_id BIGINT UNSIGNED NULL,
      notification_type VARCHAR(60) NOT NULL DEFAULT 'new_order',
      title VARCHAR(120) NOT NULL,
      message VARCHAR(255) NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY admin_notifications_order_id_index (order_id),
      KEY admin_notifications_is_read_index (is_read),
      CONSTRAINT admin_notifications_order_id_foreign
        FOREIGN KEY (order_id) REFERENCES orders(id)
        ON UPDATE CASCADE
        ON DELETE SET NULL
    )
  `);
}

async function ensureScheduledDiscountColumns() {
  const columns = await query("SHOW COLUMNS FROM products");
  const columnNames = new Set(columns.map((column) => column.Field));

  if (!columnNames.has("discount_type")) {
    await query("ALTER TABLE products ADD COLUMN discount_type ENUM('percentage', 'fixed_amount') NOT NULL DEFAULT 'percentage' AFTER decant_price_lkr");
  }
  if (!columnNames.has("discount_target")) {
    await query("ALTER TABLE products ADD COLUMN discount_target ENUM('full', 'decant', 'both') NOT NULL DEFAULT 'both' AFTER discount_type");
  }
  if (!columnNames.has("discount_percent")) {
    await query("ALTER TABLE products ADD COLUMN discount_percent DECIMAL(5, 2) NOT NULL DEFAULT 0 AFTER discount_target");
  }
  if (!columnNames.has("discount_amount_lkr")) {
    await query("ALTER TABLE products ADD COLUMN discount_amount_lkr DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER discount_percent");
  }
  if (!columnNames.has("discount_start_at")) {
    await query("ALTER TABLE products ADD COLUMN discount_start_at DATETIME NULL AFTER discount_amount_lkr");
  }
  if (!columnNames.has("discount_end_at")) {
    await query("ALTER TABLE products ADD COLUMN discount_end_at DATETIME NULL AFTER discount_start_at");
  }

  const orderColumns = await query("SHOW COLUMNS FROM orders");
  const orderColumnNames = new Set(orderColumns.map((column) => column.Field));

  if (!orderColumnNames.has("discount_lkr")) {
    await query("ALTER TABLE orders ADD COLUMN discount_lkr DECIMAL(10, 2) NOT NULL DEFAULT 0 AFTER subtotal_lkr");
  }
}

async function ensureCosmeticProductColumns() {
  const columns = await query("SHOW COLUMNS FROM products");
  const columnNames = new Set(columns.map((column) => column.Field));
  const cosmeticColumns = [
    ["key_ingredients", "TEXT NULL"],
    ["main_benefits", "TEXT NULL"],
    ["skin_type", "VARCHAR(255) NULL"],
    ["skin_concerns", "TEXT NULL"],
    ["how_to_use", "TEXT NULL"],
  ];

  for (const [columnName, definition] of cosmeticColumns) {
    if (!columnNames.has(columnName)) {
      await query(`ALTER TABLE products ADD COLUMN ${columnName} ${definition} AFTER detail_description`);
    }
  }
}

async function ensureUserVerificationColumns() {
  try {
    const columns = await query("SHOW COLUMNS FROM users");
    const columnNames = new Set(columns.map((column) => column.Field));
    const verificationColumns = [
      ["is_email_verified", "BOOLEAN NOT NULL DEFAULT FALSE"],
      ["is_phone_verified", "BOOLEAN NOT NULL DEFAULT FALSE"],
      ["email_verified_at", "TIMESTAMP NULL"],
      ["phone_verified_at", "TIMESTAMP NULL"],
    ];

    for (const [columnName, definition] of verificationColumns) {
      if (!columnNames.has(columnName)) {
        await query(`ALTER TABLE users ADD COLUMN ${columnName} ${definition}`);
      }
    }
  } catch (error) {
    console.warn(`[GlowNest DB] User verification columns check note: ${error.message}`);
  }
}

async function clearExpiredDiscounts() {
  await query(
    `UPDATE products
     SET discount_type = 'percentage',
         discount_target = 'both',
         discount_percent = 0,
         discount_amount_lkr = 0,
         discount_start_at = NULL,
         discount_end_at = NULL
     WHERE discount_end_at IS NOT NULL
       AND discount_end_at <= CURRENT_TIMESTAMP`
  );
}

function mapStatusHistory(row) {
  return {
    id: row.id,
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
  };
}

function mapCustomerNotification(row) {
  return {
    id: row.id,
    userId: row.user_id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    type: row.notification_type,
    title: row.title,
    message: row.message,
    isRead: Boolean(row.is_read),
    createdAt: row.created_at,
  };
}

function mapAdminNotification(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    type: row.notification_type,
    title: row.title,
    message: row.message,
    isRead: Boolean(row.is_read),
    createdAt: row.created_at,
  };
}

async function getAdminNotifications() {
  const rows = await query(
    `SELECT an.*, o.order_number
     FROM admin_notifications an
     LEFT JOIN orders o ON o.id = an.order_id
     ORDER BY an.created_at DESC, an.id DESC
     LIMIT 100`
  );

  return rows.map(mapAdminNotification);
}

async function addAdminOrderNotification(order, discount) {
  const discountMessage = discount > 0 ? ` Discount saved: LKR ${discount.toFixed(2)}.` : "";

  await query(
    `INSERT INTO admin_notifications (order_id, notification_type, title, message)
     VALUES (:orderId, 'new_order', :title, :message)`,
    {
      orderId: order.id,
      title: `New order ${order.order_number}`,
      message: `${order.customer_name} placed an order for LKR ${Number(order.total_lkr).toFixed(2)}.${discountMessage}`,
    }
  );
}

async function addOrderStatusHistory(orderId, status, note = null) {
  await query(
    `INSERT INTO order_status_history (order_id, status, note)
     VALUES (:orderId, :status, :note)`,
    { orderId, status, note }
  );
}

async function addCustomerOrderNotification(order, status, note = null) {
  if (!order?.user_id) {
    return;
  }

  const details = statusDetails(status, order.order_number);

  await query(
    `INSERT INTO customer_notifications (user_id, order_id, notification_type, title, message)
     VALUES (:userId, :orderId, 'order_status', :title, :message)`,
    {
      userId: order.user_id,
      orderId: order.id,
      title: details.title,
      message: note || details.message,
    }
  );
}

async function addCustomerPaymentNotification(order, paymentStatus) {
  if (!order?.user_id) {
    return;
  }

  const details = PAYMENT_STATUS_DETAILS[paymentStatus] || PAYMENT_STATUS_DETAILS.pending;
  const orderSuffix = order.order_number ? ` Order ${order.order_number}.` : "";

  await query(
    `INSERT INTO customer_notifications (user_id, order_id, notification_type, title, message)
     VALUES (:userId, :orderId, 'payment_status', :title, :message)`,
    {
      userId: order.user_id,
      orderId: order.id,
      title: details.title,
      message: `${details.message}${orderSuffix}`,
    }
  );
}

async function recordOrderStatusUpdate(order, status, note = null, { notify = true } = {}) {
  await addOrderStatusHistory(order.id, status, note);

  if (notify) {
    await addCustomerOrderNotification(order, status, note);
  }
}

async function getOrderDetail(orderId) {
  const [order] = await query(
    `SELECT o.*,
            p.transaction_reference,
            p.paid_at,
            p.updated_at AS payment_updated_at
     FROM orders o
     LEFT JOIN payments p ON p.order_id = o.id
     WHERE o.id = :orderId
     LIMIT 1`,
    { orderId }
  );

  if (!order) {
    return null;
  }

  const [items, statusHistory] = await Promise.all([
    query("SELECT * FROM order_items WHERE order_id = :orderId ORDER BY id", {
      orderId: order.id,
    }),
    query(
      `SELECT * FROM order_status_history
       WHERE order_id = :orderId
       ORDER BY created_at ASC, id ASC`,
      { orderId: order.id }
    ),
  ]);

  return {
    id: order.id,
    orderNumber: order.order_number,
    userId: order.user_id,
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    customerEmail: order.customer_email,
    deliveryAddress: order.delivery_address,
    subtotal: Number(order.subtotal_lkr || 0),
    discount: Number(order.discount_lkr || 0),
    deliveryFee: Number(order.delivery_fee_lkr || 0),
    total: Number(order.total_lkr || 0),
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status,
    orderStatus: order.order_status,
    transactionReference: order.transaction_reference,
    paidAt: order.paid_at,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    paymentUpdatedAt: order.payment_updated_at,
    items: items.map(mapOrderItem),
    statusHistory: statusHistory.map(mapStatusHistory),
  };
}

async function getAdminOrderList() {
  const rows = await query("SELECT id FROM orders ORDER BY created_at DESC, id DESC");
  return Promise.all(rows.map((row) => getOrderDetail(row.id)));
}

function normalizePaymentStatus(status) {
  const paymentStatus = String(status || "").trim();
  return ["pending", "paid", "failed", "refunded"].includes(paymentStatus) ? paymentStatus : "";
}

function normalizeOrderStatus(status, fallback = "new") {
  const orderStatus = String(status || "").trim();
  return ["new", "confirmed", "packed", "delivered", "cancelled"].includes(orderStatus)
    ? orderStatus
    : fallback;
}

function validateSignup(body) {
  if (!body.name || body.name.trim().length < 2) return "Name is required.";
  if (!body.phone || body.phone.trim().length < 9) return "Valid phone number is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email || "")) return "Valid email is required.";
  if (!body.password || body.password.length < 8) return "Password must be at least 8 characters.";
  return "";
}

function validateAccountUpdate(body) {
  if (!body.name || body.name.trim().length < 2) return "Name is required.";
  if (!body.phone || body.phone.trim().length < 9) return "Valid phone number is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email || "")) return "Valid email is required.";
  return "";
}

function activeScheduledPrice(product, basePrice, option) {
  const discountType = product.discount_type === "fixed_amount" ? "fixed_amount" : "percentage";
  const discountTarget = ["full", "decant", "both"].includes(product.discount_target)
    ? product.discount_target
    : "both";
  const percentage = Number(product.discount_percent || 0);
  const amount = Number(product.discount_amount_lkr || 0);
  const discountValue = discountType === "fixed_amount" ? amount : percentage;
  const startsAt = product.discount_start_at ? new Date(product.discount_start_at).getTime() : NaN;
  const endsAt = product.discount_end_at ? new Date(product.discount_end_at).getTime() : NaN;
  const now = Date.now();

  const appliesToOption = discountTarget === "both" || discountTarget === option;
  if (!appliesToOption || discountValue <= 0 || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) || now < startsAt || now >= endsAt) {
    return Number(basePrice || 0);
  }

  return discountType === "fixed_amount"
    ? Math.max(0, Number(basePrice || 0) - amount)
    : Math.round((Number(basePrice || 0) * (100 - percentage)) / 100);
}

const PERFUME_FULL_BOTTLE_WEIGHT_GRAMS = 600;
const BASE_DELIVERY_FEE_LKR = 500;
const EXTRA_KILOGRAM_FEE_LKR = 100;

function calculateDelivery(resolvedItems) {
  const perfumeWeightGrams = resolvedItems.reduce((total, item) => {
    const isFullPerfume = item.category === "perfumes" && item.option !== "decant";
    return total + (isFullPerfume ? PERFUME_FULL_BOTTLE_WEIGHT_GRAMS * item.quantity : 0);
  }, 0);
  const billableKilograms = Math.max(1, Math.ceil(perfumeWeightGrams / 1000));

  return {
    perfumeWeightGrams,
    billableKilograms,
    deliveryFee: BASE_DELIVERY_FEE_LKR + (billableKilograms - 1) * EXTRA_KILOGRAM_FEE_LKR,
  };
}

async function resolveOrderItems(items) {
  const resolvedItems = [];

  for (const item of items) {
    const [product] = await query(
      `SELECT p.*, c.slug AS category_slug
       FROM products p
       JOIN categories c ON c.id = p.category_id
       WHERE (p.slug = :identifier OR p.id = :identifier) AND p.is_active = TRUE
       LIMIT 1`,
      { identifier: item.id }
    );

    if (!product) {
      return { error: `${item.name || "An item"} is no longer available.` };
    }

    const quantity = Math.max(1, Math.floor(Number(item.quantity || 1)));
    if (quantity > Number(product.stock_quantity || 0)) {
      return { error: `Only ${product.stock_quantity} of ${product.name} are currently available.` };
    }

    const isCosmetic = product.category_slug === "cosmetics";
    const isDecant = !isCosmetic && item.option === "decant" && product.decant_price_lkr != null;
    const basePrice = Number(isDecant ? product.decant_price_lkr : product.price_lkr);
    const discountedPrice = activeScheduledPrice(product, basePrice, isDecant ? "decant" : "full");
    const optionLabel = isDecant ? `${product.decant_size || "10mL"} decant` : "Full bottle";

    resolvedItems.push({
      id: product.slug,
      productId: product.id,
      productSlug: product.slug,
      name: isCosmetic ? product.name : `${product.name} - ${optionLabel}`,
      quantity,
      priceValue: basePrice,
      originalPriceValue: basePrice,
      discountedPriceValue: discountedPrice,
      discountAmount: (basePrice - discountedPrice) * quantity,
      lineTotal: basePrice * quantity,
      discountedLineTotal: discountedPrice * quantity,
      type: product.product_type,
      category: product.category_slug,
      option: isDecant ? "decant" : "full",
    });
  }

  return { items: resolvedItems };
}

function generateOrderNumber() {
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `GN${Date.now()}${random}`;
}

function isPayHereConfigured() {
  return Boolean(PAYHERE_MERCHANT_ID && PAYHERE_MERCHANT_SECRET);
}

function payHereSecretHash() {
  return crypto.createHash("md5").update(PAYHERE_MERCHANT_SECRET).digest("hex").toUpperCase();
}

function createPayHereCheckoutHash({ orderId, amount, currency }) {
  const hashSource = `${PAYHERE_MERCHANT_ID}${orderId}${amount}${currency}${payHereSecretHash()}`;
  return crypto.createHash("md5").update(hashSource).digest("hex").toUpperCase();
}

function verifyPayHereNotifyHash(body) {
  const hashSource = `${body.merchant_id}${body.order_id}${body.payhere_amount}${body.payhere_currency}${body.status_code}${payHereSecretHash()}`;
  const expectedHash = crypto.createHash("md5").update(hashSource).digest("hex").toUpperCase();
  return expectedHash === String(body.md5sig || "").toUpperCase();
}

function payHerePaymentStatus(statusCode) {
  if (String(statusCode) === "2") {
    return "paid";
  }

  if (["-1", "-2", "-3"].includes(String(statusCode))) {
    return "failed";
  }

  return "pending";
}

function createPayHereCheckout({ order, customer, items }) {
  const amount = Number(order.total_lkr).toFixed(2);
  const currency = "LKR";
  const orderId = order.order_number;
  const firstItem = items[0]?.name || "GlowNest products";
  const itemLabel = items.length > 1 ? `${firstItem} + ${items.length - 1} more` : firstItem;
  const [firstName, ...lastNameParts] = String(customer.name || "GlowNest Customer").trim().split(/\s+/);

  return {
    endpoint: PAYHERE_CHECKOUT_URL,
    fields: {
      merchant_id: PAYHERE_MERCHANT_ID,
      return_url: `${FRONTEND_ORIGIN}/cart?payment=success&order=${encodeURIComponent(orderId)}`,
      cancel_url: `${FRONTEND_ORIGIN}/cart?payment=cancelled&order=${encodeURIComponent(orderId)}`,
      notify_url: `${PUBLIC_API_ORIGIN}/api/payments/payhere/notify`,
      order_id: orderId,
      items: itemLabel,
      currency,
      amount,
      first_name: firstName || "GlowNest",
      last_name: lastNameParts.join(" ") || "Customer",
      email: customer.email || process.env.PAYHERE_FALLBACK_EMAIL || "customer@glownest.lk",
      phone: customer.phone,
      address: customer.address,
      city: process.env.PAYHERE_FALLBACK_CITY || "Colombo",
      country: "Sri Lanka",
      hash: createPayHereCheckoutHash({ orderId, amount, currency }),
    },
  };
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const method = request.method;

  if (method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  try {
    if (method === "GET" && url.pathname === "/api/health") {
      await query("SELECT 1");
      sendJson(response, 200, { ok: true, service: "GlowNest backend" });
      return;
    }

    if (method === "GET" && url.pathname === "/api/products") {
      sendJson(response, 200, { products: await getProductList(url) });
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/api/products/")) {
      const slug = decodeURIComponent(url.pathname.replace("/api/products/", ""));
      const product = await getProductDetail(slug);

      if (!product) {
        sendJson(response, 404, { error: "Product not found." });
        return;
      }

      sendJson(response, 200, { product });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/signup") {
      const body = await readBody(request);
      const validationError = validateSignup(body);

      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }

      const email = body.email.trim().toLowerCase();
      const phone = normalizePhone(body.phone);
      const [existingUser] = await query("SELECT id FROM users WHERE email = :email", { email });

      if (existingUser) {
        sendJson(response, 409, { error: "This email already has an account. Please log in instead." });
        return;
      }

      const result = await query(
        `INSERT INTO users (full_name, phone, email, password_hash, is_email_verified, is_phone_verified)
         VALUES (:name, :phone, :email, :passwordHash, FALSE, FALSE)`,
        {
          name: body.name.trim(),
          phone,
          email,
          passwordHash: hashPassword(body.password),
        }
      );

      const [user] = await query("SELECT * FROM users WHERE id = :id", { id: result.insertId });

      sendJson(response, 201, { user: publicUser(user), token: createToken(user.id) });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/signup/request-otp") {
      cleanupSignupOtpSessions();

      const body = await readBody(request);
      const validationError = validateSignup(body);

      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }

      const email = body.email.trim().toLowerCase();
      const phone = normalizePhone(body.phone);
      const [existingUser] = await query("SELECT id FROM users WHERE email = :email", { email });

      if (existingUser) {
        sendJson(response, 409, { error: "This email already has an account." });
        return;
      }

      const otpSession = createSignupOtpSession({
        name: body.name.trim(),
        phone,
        email,
        password: body.password,
      });

      await sendSignupOtp({
        email,
        phone,
        emailOtp: otpSession.emailOtp,
        phoneOtp: otpSession.phoneOtp,
        name: body.name?.trim() || "Customer",
      });

      sendJson(response, 200, {
        verificationId: otpSession.verificationId,
        expiresInMinutes: Math.round(OTP_EXPIRY_MS / 60_000),
        message: "OTP codes sent to your email and phone.",
        ...(OTP_DEV_MODE
          ? {
              devOtp: {
                email: otpSession.emailOtp,
                phone: otpSession.phoneOtp,
              },
            }
          : {}),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/signup/verify") {
      cleanupSignupOtpSessions();

      const body = await readBody(request);
      const session = signupOtpSessions.get(String(body.verificationId || ""));

      if (!session) {
        sendJson(response, 400, { error: "OTP session expired. Please request new OTP codes." });
        return;
      }

      if (session.attempts >= 5) {
        signupOtpSessions.delete(String(body.verificationId || ""));
        sendJson(response, 429, { error: "Too many wrong OTP attempts. Please request new OTP codes." });
        return;
      }

      const emailOtp = String(body.emailOtp || "").trim();
      const phoneOtp = String(body.phoneOtp || "").trim();
      const isEmailVerified = /^\d{6}$/.test(emailOtp) && safeOtpMatch(emailOtp, session.emailOtpHash);
      const isPhoneVerified = /^\d{6}$/.test(phoneOtp) && safeOtpMatch(phoneOtp, session.phoneOtpHash);

      if (!isEmailVerified || !isPhoneVerified) {
        session.attempts += 1;
        sendJson(response, 400, { error: "Email OTP or phone OTP is incorrect." });
        return;
      }

      const [existingUser] = await query("SELECT id FROM users WHERE email = :email", {
        email: session.userInput.email,
      });

      if (existingUser) {
        signupOtpSessions.delete(String(body.verificationId || ""));
        sendJson(response, 409, { error: "This email already has an account." });
        return;
      }

      const result = await query(
        `INSERT INTO users (full_name, phone, email, password_hash, is_email_verified, is_phone_verified)
         VALUES (:name, :phone, :email, :passwordHash, TRUE, TRUE)`,
        {
          name: session.userInput.name,
          phone: session.userInput.phone,
          email: session.userInput.email,
          passwordHash: hashPassword(session.userInput.password),
        }
      );

      signupOtpSessions.delete(String(body.verificationId || ""));

      const [user] = await query("SELECT * FROM users WHERE id = :id", { id: result.insertId });

      sendJson(response, 201, { user: publicUser(user), token: createToken(user.id) });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/verify-email/request-otp") {
      cleanupAccountOtpSessions();
      const user = await getCurrentUser(request);

      if (!user) {
        sendJson(response, 401, { error: "Please log in first." });
        return;
      }

      if (user.is_email_verified) {
        sendJson(response, 400, { error: "Your email is already verified." });
        return;
      }

      const emailOtp = createOtpCode();
      const sessionKey = `email_${user.id}`;
      accountOtpSessions.set(sessionKey, {
        userId: user.id,
        type: "email",
        target: user.email,
        otpHash: hashOtp(emailOtp),
        attempts: 0,
        expiresAt: Date.now() + OTP_EXPIRY_MS,
      });

      try {
        await sendEmailVerificationOtp({
          to: user.email,
          otpCode: emailOtp,
          name: user.full_name || "Customer",
        });
      } catch (err) {
        console.error("[Mailer Error]", err);
      }

      if (OTP_DEV_MODE) {
        console.log(`[Email OTP Dev Log] User ${user.id} (${user.email}): ${emailOtp}`);
      }

      sendJson(response, 200, {
        message: `Verification code sent to ${user.email}.`,
        expiresInMinutes: Math.round(OTP_EXPIRY_MS / 60_000),
        ...(OTP_DEV_MODE ? { devOtp: emailOtp } : {}),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/verify-email/confirm") {
      cleanupAccountOtpSessions();
      const user = await getCurrentUser(request);

      if (!user) {
        sendJson(response, 401, { error: "Please log in first." });
        return;
      }

      const body = await readBody(request);
      const otp = String(body.otp || "").trim();
      const sessionKey = `email_${user.id}`;
      const session = accountOtpSessions.get(sessionKey);

      if (!session || session.expiresAt < Date.now()) {
        accountOtpSessions.delete(sessionKey);
        sendJson(response, 400, { error: "Verification code expired. Please request a new code." });
        return;
      }

      if (session.attempts >= 5) {
        accountOtpSessions.delete(sessionKey);
        sendJson(response, 429, { error: "Too many wrong attempts. Please request a new code." });
        return;
      }

      if (!/^\d{6}$/.test(otp) || !safeOtpMatch(otp, session.otpHash)) {
        session.attempts += 1;
        sendJson(response, 400, { error: "Invalid verification code. Please check and try again." });
        return;
      }

      accountOtpSessions.delete(sessionKey);

      await query(
        `UPDATE users 
         SET is_email_verified = TRUE, email_verified_at = CURRENT_TIMESTAMP 
         WHERE id = :id`,
        { id: user.id }
      );

      const [updatedUser] = await query("SELECT * FROM users WHERE id = :id", { id: user.id });

      sendJson(response, 200, {
        message: "Email verified successfully!",
        user: publicUser(updatedUser),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/verify-phone/request-otp") {
      cleanupAccountOtpSessions();
      const user = await getCurrentUser(request);

      if (!user) {
        sendJson(response, 401, { error: "Please log in first." });
        return;
      }

      if (user.is_phone_verified) {
        sendJson(response, 400, { error: "Your phone number is already verified." });
        return;
      }

      const phoneOtp = createOtpCode();
      const sessionKey = `phone_${user.id}`;
      accountOtpSessions.set(sessionKey, {
        userId: user.id,
        type: "phone",
        target: user.phone,
        otpHash: hashOtp(phoneOtp),
        attempts: 0,
        expiresAt: Date.now() + OTP_EXPIRY_MS,
      });

      try {
        await sendPhoneVerificationOtp({
          phone: user.phone,
          otpCode: phoneOtp,
        });
      } catch (err) {
        console.error("[SMS Error]", err);
      }

      if (OTP_DEV_MODE) {
        console.log(`[Phone OTP Dev Log] User ${user.id} (${user.phone}): ${phoneOtp}`);
      }

      sendJson(response, 200, {
        message: `Verification code sent to ${user.phone}.`,
        expiresInMinutes: Math.round(OTP_EXPIRY_MS / 60_000),
        ...(OTP_DEV_MODE ? { devOtp: phoneOtp } : {}),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/verify-phone/confirm") {
      cleanupAccountOtpSessions();
      const user = await getCurrentUser(request);

      if (!user) {
        sendJson(response, 401, { error: "Please log in first." });
        return;
      }

      const body = await readBody(request);
      const otp = String(body.otp || "").trim();
      const sessionKey = `phone_${user.id}`;
      const session = accountOtpSessions.get(sessionKey);

      if (!session || session.expiresAt < Date.now()) {
        accountOtpSessions.delete(sessionKey);
        sendJson(response, 400, { error: "Verification code expired. Please request a new code." });
        return;
      }

      if (session.attempts >= 5) {
        accountOtpSessions.delete(sessionKey);
        sendJson(response, 429, { error: "Too many wrong attempts. Please request a new code." });
        return;
      }

      if (!/^\d{6}$/.test(otp) || !safeOtpMatch(otp, session.otpHash)) {
        session.attempts += 1;
        sendJson(response, 400, { error: "Invalid verification code. Please check and try again." });
        return;
      }

      accountOtpSessions.delete(sessionKey);

      await query(
        `UPDATE users 
         SET is_phone_verified = TRUE, phone_verified_at = CURRENT_TIMESTAMP 
         WHERE id = :id`,
        { id: user.id }
      );

      const [updatedUser] = await query("SELECT * FROM users WHERE id = :id", { id: user.id });

      sendJson(response, 200, {
        message: "Phone number verified successfully!",
        user: publicUser(updatedUser),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/change-password") {
      const user = await getCurrentUser(request);

      if (!user) {
        sendJson(response, 401, { error: "Please log in first." });
        return;
      }

      const body = await readBody(request);
      const currentPassword = String(body.currentPassword || "");
      const newPassword = String(body.newPassword || "");

      if (!verifyPassword(currentPassword, user.password_hash)) {
        sendJson(response, 400, { error: "Current password is incorrect." });
        return;
      }

      if (newPassword.length < 8) {
        sendJson(response, 400, { error: "New password must be at least 8 characters long." });
        return;
      }

      await query(
        "UPDATE users SET password_hash = :passwordHash WHERE id = :id",
        { id: user.id, passwordHash: hashPassword(newPassword) }
      );

      sendJson(response, 200, { message: "Password updated successfully!" });
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readBody(request);
      const email = String(body.email || "").trim().toLowerCase();
      const [user] = await query(
        "SELECT * FROM users WHERE email = :email AND role = 'customer' AND status = 'active'",
        { email }
      );

      if (!user || !verifyPassword(String(body.password || ""), user.password_hash)) {
        sendJson(response, 401, { error: "Email or password is incorrect." });
        return;
      }

      sendJson(response, 200, { user: publicUser(user), token: createToken(user.id) });
      return;
    }

    if (method === "GET" && url.pathname === "/api/auth/me") {
      const user = await getCurrentUser(request);

      if (!user) {
        sendJson(response, 401, { error: "Please login first." });
        return;
      }

      sendJson(response, 200, { user: publicUser(user) });
      return;
    }

    if (method === "PUT" && url.pathname === "/api/auth/me") {
      const user = await getCurrentUser(request);

      if (!user) {
        sendJson(response, 401, { error: "Please login first." });
        return;
      }

      const body = await readBody(request);
      const validationError = validateAccountUpdate(body);

      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }

      const email = body.email.trim().toLowerCase();
      const phone = normalizePhone(body.phone);
      const [existingUser] = await query(
        "SELECT id FROM users WHERE email = :email AND id <> :id",
        { email, id: user.id }
      );

      if (existingUser) {
        sendJson(response, 409, { error: "This email is already used by another account." });
        return;
      }

      const emailChanged = email !== user.email;
      const phoneChanged = phone !== user.phone;

      await query(
        `UPDATE users
         SET full_name = :name,
             phone = :phone,
             email = :email,
             is_email_verified = CASE WHEN :emailChanged = 1 THEN FALSE ELSE is_email_verified END,
             email_verified_at = CASE WHEN :emailChanged = 1 THEN NULL ELSE email_verified_at END,
             is_phone_verified = CASE WHEN :phoneChanged = 1 THEN FALSE ELSE is_phone_verified END,
             phone_verified_at = CASE WHEN :phoneChanged = 1 THEN NULL ELSE phone_verified_at END
         WHERE id = :id`,
        {
          id: user.id,
          name: body.name.trim(),
          phone,
          email,
          emailChanged: emailChanged ? 1 : 0,
          phoneChanged: phoneChanged ? 1 : 0,
        }
      );

      const [updatedUser] = await query("SELECT * FROM users WHERE id = :id", { id: user.id });
      sendJson(response, 200, { user: publicUser(updatedUser) });
      return;
    }

    if (method === "GET" && url.pathname === "/api/admin/auth/setup-status") {
      await ensureAdminTable();
      const [result] = await adminQuery("SELECT COUNT(*) AS admin_count FROM admin_users");
      sendJson(response, 200, { requiresSetup: Number(result.admin_count) === 0 });
      return;
    }

    if (method === "POST" && url.pathname === "/api/admin/auth/register") {
      const body = await readBody(request);
      const name = String(body.name || body.fullName || "").trim();
      const phone = String(body.phone || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");

      if (name.length < 2) {
        sendJson(response, 400, { error: "Admin name is required." });
        return;
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendJson(response, 400, { error: "A valid admin email is required." });
        return;
      }

      if (password.length < 8) {
        sendJson(response, 400, { error: "Password must be at least 8 characters." });
        return;
      }

      await ensureAdminTable();
      const [existingAdmin] = await adminQuery("SELECT id FROM admin_users WHERE email = :email", {
        email,
      });

      if (existingAdmin) {
        sendJson(response, 409, { error: "This admin email is already registered." });
        return;
      }

      const result = await adminQuery(
        `INSERT INTO admin_users (full_name, phone, email, password_hash)
         VALUES (:name, :phone, :email, :passwordHash)`,
        {
          name,
          phone,
          email,
          passwordHash: hashPassword(password),
        }
      );

      const [admin] = await adminQuery("SELECT * FROM admin_users WHERE id = :id", {
        id: result.insertId,
      });
      sendJson(response, 201, { user: publicAdmin(admin), token: createAdminToken(admin.id) });
      return;
    }

    if (method === "POST" && url.pathname === "/api/admin/auth/login") {
      const body = await readBody(request);
      const email = String(body.email || "").trim().toLowerCase();

      await ensureAdminTable();
      const [admin] = await adminQuery(
        "SELECT * FROM admin_users WHERE email = :email AND status = 'active'",
        { email }
      );

      if (!admin || !verifyPassword(String(body.password || ""), admin.password_hash)) {
        sendJson(response, 401, { error: "Admin email or password is incorrect." });
        return;
      }

      sendJson(response, 200, { user: publicAdmin(admin), token: createAdminToken(admin.id) });
      return;
    }

    if (method === "GET" && url.pathname === "/api/admin/auth/me") {
      const admin = await getCurrentAdmin(request);

      if (!admin) {
        sendJson(response, 401, { error: "Admin login is required." });
        return;
      }

      sendJson(response, 200, { user: publicAdmin(admin) });
      return;
    }

    if (method === "POST" && url.pathname === "/api/admin/uploads") {
      const admin = await requireAdmin(request, response);

      if (!admin) {
        return;
      }

      const upload = parseMultipartImage(request, await readRawBody(request));
      const imageUrl = await saveUploadedProductImage(upload);

      sendJson(response, 201, { imageUrl });
      return;
    }

    if (method === "GET" && url.pathname === "/api/admin/products") {
      const admin = await requireAdmin(request, response);

      if (!admin) {
        return;
      }

      sendJson(response, 200, { products: await getAdminProductList() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/admin/orders") {
      const admin = await requireAdmin(request, response);

      if (!admin) {
        return;
      }

      sendJson(response, 200, { orders: await getAdminOrderList() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/admin/notifications") {
      const admin = await requireAdmin(request, response);

      if (!admin) return;

      sendJson(response, 200, { notifications: await getAdminNotifications() });
      return;
    }

    if (method === "PUT" && url.pathname === "/api/admin/notifications/read") {
      const admin = await requireAdmin(request, response);

      if (!admin) return;

      await query("UPDATE admin_notifications SET is_read = TRUE WHERE is_read = FALSE");
      sendJson(response, 200, { notifications: await getAdminNotifications() });
      return;
    }

    if (method === "DELETE" && url.pathname.startsWith("/api/admin/notifications/")) {
      const admin = await requireAdmin(request, response);

      if (!admin) return;

      const notificationId = url.pathname.split("/").filter(Boolean)[3];
      await query("DELETE FROM admin_notifications WHERE id = :id", { id: notificationId });
      sendJson(response, 200, { notifications: await getAdminNotifications() });
      return;
    }

    if (method === "PUT" && url.pathname.startsWith("/api/admin/orders/")) {
      const admin = await requireAdmin(request, response);

      if (!admin) {
        return;
      }

      const pathParts = url.pathname.split("/").filter(Boolean);
      const orderId = pathParts[3];
      const action = pathParts[4];

      if (!["payment", "status"].includes(action)) {
        sendJson(response, 404, { error: "Route not found." });
        return;
      }

      const [existingOrder] = await query("SELECT * FROM orders WHERE id = :id", { id: orderId });

      if (!existingOrder) {
        sendJson(response, 404, { error: "Order not found." });
        return;
      }

      const body = await readBody(request);

      if (action === "payment") {
        const paymentStatus = normalizePaymentStatus(body.paymentStatus);

        if (!paymentStatus) {
          sendJson(response, 400, { error: "Choose a valid payment status." });
          return;
        }

        const orderStatus =
          body.orderStatus ||
          (paymentStatus === "paid" ? "confirmed" : paymentStatus === "failed" ? "cancelled" : existingOrder.order_status);
        const nextOrderStatus = normalizeOrderStatus(orderStatus, existingOrder.order_status);
        const transactionReference = String(body.transactionReference || "").trim() || null;

        await query(
          `UPDATE orders
           SET payment_status = :paymentStatus,
               order_status = :orderStatus
           WHERE id = :orderId`,
          { orderId, paymentStatus, orderStatus: nextOrderStatus }
        );

        await query(
          `UPDATE payments
           SET status = :paymentStatus,
               transaction_reference = COALESCE(:transactionReference, transaction_reference),
               paid_at = CASE WHEN :paymentStatus = 'paid' THEN COALESCE(paid_at, CURRENT_TIMESTAMP) ELSE paid_at END
           WHERE order_id = :orderId`,
          { orderId, paymentStatus, transactionReference }
        );

        if (nextOrderStatus !== existingOrder.order_status) {
          await recordOrderStatusUpdate(existingOrder, nextOrderStatus);
        } else if (paymentStatus !== existingOrder.payment_status) {
          await addCustomerPaymentNotification(existingOrder, paymentStatus);
        }

        sendJson(response, 200, { order: await getOrderDetail(orderId) });
        return;
      }

      if (action === "status") {
        const orderStatus = normalizeOrderStatus(body.orderStatus, existingOrder.order_status);

        if (!["confirmed", "packed", "delivered"].includes(orderStatus)) {
          sendJson(response, 400, { error: "Choose order received, packed, or order delivered." });
          return;
        }

        await query("UPDATE orders SET order_status = :orderStatus WHERE id = :orderId", {
          orderId,
          orderStatus,
        });

        if (orderStatus !== existingOrder.order_status) {
          await recordOrderStatusUpdate(existingOrder, orderStatus);
        }

        sendJson(response, 200, { order: await getOrderDetail(orderId) });
        return;
      }

      sendJson(response, 404, { error: "Route not found." });
      return;
    }

    if (method === "DELETE" && url.pathname.startsWith("/api/admin/orders/")) {
      const admin = await requireAdmin(request, response);

      if (!admin) {
        return;
      }

      const pathParts = url.pathname.split("/").filter(Boolean);
      const orderId = pathParts[3];
      const [existingOrder] = await query("SELECT id FROM orders WHERE id = :id", { id: orderId });

      if (!existingOrder) {
        sendJson(response, 404, { error: "Order not found." });
        return;
      }

      await query("DELETE FROM orders WHERE id = :orderId", { orderId });

      sendJson(response, 200, { orders: await getAdminOrderList() });
      return;
    }

    if (method === "POST" && url.pathname === "/api/admin/products") {
      const admin = await requireAdmin(request, response);

      if (!admin) {
        return;
      }

      const input = await productInput(await readBody(request));

      if (input.error) {
        sendJson(response, 400, { error: input.error });
        return;
      }

      const result = await query(
        `INSERT INTO products (
          category_id, name, slug, brand, product_type, concentration, gender, volume,
          fragrance_family, release_year, perfumers, price_lkr, decant_price_lkr,
          discount_type, discount_target, discount_percent, discount_amount_lkr, discount_start_at, discount_end_at,
          decant_size, koko_pay_text, short_description, detail_description,
          key_ingredients, main_benefits, skin_type, skin_concerns, how_to_use,
          image_url, detail_image_url, stock_quantity, is_active
        ) VALUES (
          :categoryId, :name, :slug, :brand, :type, :concentration, :gender, :volume,
          :fragranceFamily, :releaseYear, :perfumers, :priceValue, :decantPriceValue,
          :discountType, :discountTarget, :discountPercent, :discountAmount, :discountStartAt, :discountEndAt,
          :decantSize, :kokoPay, :shortDescription, :detailDescription,
          :keyIngredients, :mainBenefits, :skinType, :skinConcerns, :howToUse,
          :image, :detailImage, :stockQuantity, :isActive
        )`,
        input
      );

      await replaceProductDetails(result.insertId, input);

      const product = await getProductDetail(input.slug);
      sendJson(response, 201, { product });
      return;
    }

    if (method === "PUT" && url.pathname.startsWith("/api/admin/products/")) {
      const admin = await requireAdmin(request, response);

      if (!admin) {
        return;
      }

      const pathParts = url.pathname.split("/").filter(Boolean);
      const productId = pathParts[3];
      const isStatusOnly = pathParts[4] === "status";
      const [existingProduct] = await query("SELECT id FROM products WHERE id = :id", { id: productId });

      if (!existingProduct) {
        sendJson(response, 404, { error: "Product not found." });
        return;
      }

      const body = await readBody(request);

      if (isStatusOnly) {
        const stockQuantity =
          body.stockStatus === "out_of_stock" ? 0 : Math.max(1, Number(body.stockQuantity || 1));

        await query(
          "UPDATE products SET stock_quantity = :stockQuantity, is_active = :isActive WHERE id = :id",
          {
            id: productId,
            stockQuantity,
            isActive: body.isActive !== false,
          }
        );

        sendJson(response, 200, { products: await getAdminProductList() });
        return;
      }

      const input = await productInput(body, productId);

      if (input.error) {
        sendJson(response, 400, { error: input.error });
        return;
      }

      await query(
        `UPDATE products
         SET category_id = :categoryId, name = :name, slug = :slug, brand = :brand,
             product_type = :type, concentration = :concentration, gender = :gender,
             volume = :volume, fragrance_family = :fragranceFamily,
             release_year = :releaseYear, perfumers = :perfumers,
             price_lkr = :priceValue, decant_price_lkr = :decantPriceValue,
             discount_type = :discountType,
             discount_target = :discountTarget,
             discount_percent = :discountPercent,
             discount_amount_lkr = :discountAmount,
             discount_start_at = :discountStartAt,
             discount_end_at = :discountEndAt,
             decant_size = :decantSize, koko_pay_text = :kokoPay,
             short_description = :shortDescription, detail_description = :detailDescription,
             key_ingredients = :keyIngredients, main_benefits = :mainBenefits,
             skin_type = :skinType, skin_concerns = :skinConcerns, how_to_use = :howToUse,
             image_url = :image, detail_image_url = :detailImage,
             stock_quantity = :stockQuantity, is_active = :isActive
         WHERE id = :id`,
        { ...input, id: productId }
      );

      await replaceProductDetails(productId, input);

      const product = await getProductDetail(input.slug);
      sendJson(response, 200, { product });
      return;
    }

    if (method === "POST" && url.pathname === "/api/payments/payhere/notify") {
      const body = await readFormBody(request);

      if (!isPayHereConfigured() || body.merchant_id !== PAYHERE_MERCHANT_ID || !verifyPayHereNotifyHash(body)) {
        response.writeHead(400, { "Content-Type": "text/plain" });
        response.end("Invalid payment notification.");
        return;
      }

      const paymentStatus = payHerePaymentStatus(body.status_code);
      const [order] = await query("SELECT * FROM orders WHERE order_number = :orderNumber", {
        orderNumber: body.order_id,
      });

      if (!order) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Order not found.");
        return;
      }

      await query(
        `UPDATE orders
         SET payment_status = :paymentStatus,
             order_status = CASE WHEN :paymentStatus = 'paid' THEN 'confirmed' ELSE order_status END
         WHERE id = :orderId`,
        { orderId: order.id, paymentStatus }
      );

      await query(
        `UPDATE payments
         SET status = :paymentStatus,
             transaction_reference = :transactionReference,
             paid_at = CASE WHEN :paymentStatus = 'paid' THEN CURRENT_TIMESTAMP ELSE paid_at END
         WHERE order_id = :orderId AND payment_method = 'card'`,
        {
          orderId: order.id,
          paymentStatus,
          transactionReference: body.payment_id || body.payhere_payment_id || null,
        }
      );

      const nextOrderStatus = paymentStatus === "paid" ? "confirmed" : order.order_status;

      if (nextOrderStatus !== order.order_status) {
        await recordOrderStatusUpdate(order, nextOrderStatus);
      } else if (paymentStatus !== order.payment_status) {
        await addCustomerPaymentNotification(order, paymentStatus);
      }

      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("OK");
      return;
    }

    if (method === "POST" && url.pathname === "/api/orders") {
      const body = await readBody(request);
      const user = await getCurrentUser(request);
      const items = Array.isArray(body.items) ? body.items : [];
      const customer = body.customer || {};
      const paymentMethod = body.paymentMethod === "card" ? "card" : "cash_on_delivery";
      const paymentStatus = paymentMethod === "card" ? "pending" : "pending";

      if (items.length === 0) {
        sendJson(response, 400, { error: "Order needs at least one item." });
        return;
      }

      if (!customer.name || !customer.phone) {
        sendJson(response, 400, { error: "Customer name and phone are required." });
        return;
      }

      if (paymentMethod === "card" && !isPayHereConfigured()) {
        sendJson(response, 503, {
          error:
            "PayHere is not configured yet. Add PAYHERE_MERCHANT_ID and PAYHERE_MERCHANT_SECRET to BackEnd/.env.",
        });
        return;
      }

      const resolvedOrder = await resolveOrderItems(items);

      if (resolvedOrder.error) {
        sendJson(response, 400, { error: resolvedOrder.error });
        return;
      }

      const resolvedItems = resolvedOrder.items;
      const delivery = calculateDelivery(resolvedItems);
      const deliveryFee = delivery.deliveryFee;
      const subtotal = resolvedItems.reduce((sum, item) => sum + item.lineTotal, 0);
      const discount = resolvedItems.reduce((sum, item) => sum + item.discountAmount, 0);
      const total = subtotal - discount + deliveryFee;
      const orderNumber = generateOrderNumber();

      const orderResult = await query(
        `INSERT INTO orders (
          order_number, user_id, customer_name, customer_phone, customer_email,
          delivery_address, subtotal_lkr, discount_lkr, delivery_fee_lkr, total_lkr,
          payment_method, payment_status, order_status
        ) VALUES (
          :orderNumber, :userId, :customerName, :customerPhone, :customerEmail,
          :deliveryAddress, :subtotal, :discount, :deliveryFee, :total,
          :paymentMethod, :paymentStatus, 'confirmed'
        )`,
        {
          orderNumber,
          userId: user?.id || null,
          customerName: customer.name,
          customerPhone: customer.phone,
          customerEmail: customer.email || user?.email || null,
          deliveryAddress: customer.address || null,
          subtotal,
          discount,
          deliveryFee,
          total,
          paymentMethod,
          paymentStatus,
        }
      );

      const orderId = orderResult.insertId;

      await addOrderStatusHistory(orderId, "confirmed", "Order placed successfully.");

      await query(
        `INSERT INTO payments (order_id, payment_method, amount_lkr, status)
         VALUES (:orderId, :paymentMethod, :amount, :paymentStatus)`,
        { orderId, paymentMethod, amount: total, paymentStatus }
      );

      for (const item of resolvedItems) {
        await query(
          `INSERT INTO order_items (order_id, product_id, product_name, product_slug, quantity, unit_price_lkr, line_total_lkr)
           VALUES (:orderId, :productId, :productName, :productSlug, :quantity, :unitPrice, :lineTotal)`,
          {
            orderId,
            productId: item.productId,
            productName: item.name,
            productSlug: item.productSlug,
            quantity: item.quantity,
            unitPrice: item.originalPriceValue,
            lineTotal: item.lineTotal,
          }
        );
      }

      const [order] = await query("SELECT * FROM orders WHERE id = :id", { id: orderId });
      await addAdminOrderNotification(order, discount);
      sendJson(response, 201, {
        order: {
          ...order,
          items: resolvedItems,
          deliveryWeightGrams: delivery.perfumeWeightGrams,
          billableKilograms: delivery.billableKilograms,
          paymentGateway:
            paymentMethod === "card"
              ? createPayHereCheckout({
                  order,
                  customer: {
                    ...customer,
                    email: customer.email || user?.email || null,
                  },
                  items: resolvedItems,
                })
              : null,
        },
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/customer/notifications") {
      const user = await getCurrentUser(request);

      if (!user) {
        sendJson(response, 401, { error: "Please login first." });
        return;
      }

      const notifications = await query(
        `SELECT cn.*, o.order_number
         FROM customer_notifications cn
         LEFT JOIN orders o ON o.id = cn.order_id
         WHERE cn.user_id = :userId
         ORDER BY cn.created_at DESC, cn.id DESC
         LIMIT 40`,
        { userId: user.id }
      );

      sendJson(response, 200, { notifications: notifications.map(mapCustomerNotification) });
      return;
    }

    if (method === "PUT" && url.pathname === "/api/customer/notifications/read") {
      const user = await getCurrentUser(request);

      if (!user) {
        sendJson(response, 401, { error: "Please login first." });
        return;
      }

      await query("UPDATE customer_notifications SET is_read = TRUE WHERE user_id = :userId", {
        userId: user.id,
      });

      const notifications = await query(
        `SELECT cn.*, o.order_number
         FROM customer_notifications cn
         LEFT JOIN orders o ON o.id = cn.order_id
         WHERE cn.user_id = :userId
         ORDER BY cn.created_at DESC, cn.id DESC
         LIMIT 40`,
        { userId: user.id }
      );

      sendJson(response, 200, { notifications: notifications.map(mapCustomerNotification) });
      return;
    }

    if (method === "GET" && url.pathname === "/api/orders") {
      const user = await getCurrentUser(request);

      if (!user) {
        sendJson(response, 401, { error: "Please login first." });
        return;
      }

      const orderRows = await query(
        "SELECT id FROM orders WHERE user_id = :userId ORDER BY created_at DESC, id DESC",
        { userId: user.id }
      );

      const orders = await Promise.all(orderRows.map((order) => getOrderDetail(order.id)));

      sendJson(response, 200, { orders: orders.filter(Boolean) });
      return;
    }

    sendJson(response, 404, { error: "Route not found." });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Server error." });
  }
}

Promise.all([
  ensureOrderNotificationTables(),
  ensureScheduledDiscountColumns(),
  ensureCosmeticProductColumns(),
  ensureUserVerificationColumns(),
])
  .then(async () => {
    await clearExpiredDiscounts();
    const discountCleanupTimer = setInterval(() => {
      clearExpiredDiscounts().catch((error) => {
        console.error("Could not clear expired discounts.", error);
      });
    }, 60_000);
    discountCleanupTimer.unref?.();

    createServer(handleRequest).listen(PORT, "127.0.0.1", () => {
      console.log(`GlowNest backend running on http://127.0.0.1:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Could not prepare GlowNest database tables.", error);
    process.exit(1);
  });
