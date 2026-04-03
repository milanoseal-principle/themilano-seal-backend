"use strict";

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");
require("dotenv").config();

const { calculatePrice, suggestTier } = require("./core/pricing");
const { buildInvoice, genInvoiceNumber } = require("./core/invoice");

const app = express();
const PORT = process.env.PORT || 3000;

// ── CLIENTS ────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── TWILIO ────────────────────────────────────────────────
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}

// ── MIDDLEWARE ─────────────────────────────────────────────
app.use(cors({
  origin: "*",
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// ── ROOT ───────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.send("Milano Seal Backend Running");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ── WHATSAPP ───────────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  if (!twilioClient || !phone) return;

  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
    });
  } catch (err) {
    console.error("Twilio error:", err.message);
  }
}

// ── POST /api/intake ───────────────────────────────────────
app.post("/api/intake", async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      document_type,
      destination_country
    } = req.body;

    if (!name || !email || !document_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const tier = suggestTier({});
    const pricing = calculatePrice({ tier });

    // CLIENT
    const { data: client } = await supabase
      .from("clients")
      .insert([{ name, email, phone }])
      .select()
      .single();

    const invoiceNum = genInvoiceNumber();

    // DEAL
    const { data: deal } = await supabase
      .from("deals")
      .insert([{
        client_id: client?.id || null,
        document_type,
        destination_country,
        tier,
        total_price: pricing.total,
        invoice_number: invoiceNum,
        status: "new"
      }])
      .select()
      .single();

    const invoice = buildInvoice(deal, client, pricing);

    // WHATSAPP
    if (phone) {
      await sendWhatsApp(
        phone,
        `Milano Seal — Received. Invoice: ${invoiceNum}`
      );
    }

    res.json({
      success: true,
      deal_id: deal?.id,
      invoice_number: invoiceNum,
      pricing
    });

  } catch (err) {
    console.error("INTAKE ERROR:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── GET DEALS ──────────────────────────────────────────────
app.get("/api/deals", async (_req, res) => {
  const { data } = await supabase
    .from("deals")
    .select("*")
    .limit(50);

  res.json(data);
});

// ── START ──────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
