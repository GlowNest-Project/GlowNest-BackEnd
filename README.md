# GlowNest Backend

This is the first backend for GlowNest. It uses plain Node.js, so you do not need to install extra packages yet.

## Run

```bash
cd BackEnd
npm run dev
```

The API runs at:

```text
http://127.0.0.1:4000
```

## Main API Routes

```text
GET  /api/health
GET  /api/products
GET  /api/products?category=perfumes
GET  /api/products/:slug
POST /api/auth/signup
POST /api/auth/login
GET  /api/auth/me
POST /api/orders
GET  /api/orders
GET  /api/admin/auth/setup-status
POST /api/admin/auth/register
POST /api/admin/auth/login
```

## Signup Body

```json
{
  "name": "Customer Name",
  "phone": "0766721584",
  "email": "customer@example.com",
  "password": "secret123"
}
```

## Login Body

```json
{
  "email": "customer@example.com",
  "password": "secret123"
}
```

## Order Body

```json
{
  "customer": {
    "name": "Customer Name",
    "phone": "0766721584",
    "address": "Delivery address"
  },
  "items": [
    {
      "id": "azzaro-most-wanted-parfum",
      "name": "Azzaro The Most Wanted Parfum",
      "quantity": 1,
      "priceValue": 25000
    }
  ]
}
```

User accounts and orders are saved in:

```text
BackEnd/data/db.json
```

## MySQL Tables

The MySQL table script is here:

```text
BackEnd/database/schema.sql
```

It creates:

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

Administrator credentials are stored separately in the `glownest_admin_db`
database, in the `admin_users` table. Passwords are saved only as salted
hashes. Customer login does not read this database.

Create the dedicated admin database and grant the application account access:

```bash
cd BackEnd
npm run db:admin-schema
```

MySQL will request the local root password. Then open `/admin`. If the admin
database is empty, GlowNest displays the one-time **Create First Admin** form.
After the first account is created, public admin registration is disabled and
the same page displays only **Admin Sign In**.

To create the tables in MySQL:

```bash
mysql -u root -p < BackEnd/database/schema.sql
```
