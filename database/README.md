# GlowNest MySQL Database

Use this folder for GlowNest database setup.

## Create Tables

From the `BackEnd` folder, run:

```bash
npm run db:schema
```

Then enter your MySQL password.

This creates a database named:

```text
glownest_db
```

## Tables Created

```text
users
categories
products
product_notes
product_accords
product_images
carts
cart_items
orders
order_items
payments
customer_addresses
```

## Recommended Order Flow

1. Customer creates an account in `users`.
2. Customer adds products to `carts` and `cart_items`.
3. Customer confirms order.
4. Backend creates `orders` and `order_items`.
5. Payment information is saved in `payments`.
6. Admin updates `order_status`.
