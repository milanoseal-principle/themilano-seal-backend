"use strict";

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");
require("dotenv").config();

const { calculatePrice, suggestTier } = require("./core/pricing");
const { getComplianceByCountry, resolveJurisdiction } = require("./core/compliance");
const { buildInvoice, genInvoiceNumber } = require("./core/invoice");

const app = express();
const PORT = process.env.PORT || 3000;

// ── CLIENTS ────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}

// ── MIDDLEWARE ─────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || "http://localhost:3000",
    "https://themilanoseal.com",
    "https://www.themilanoseal.com",
    "https://themilanoseal.vercel.app",
  ],
  credentials: true,
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── ROOT + HEALTH ──────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ system: "Trust Engine™", brand: "The Milano Seal™" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ── WHATSAPP ───────────────────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  if (!twilioClient || !phone) return { skipped: true };

  const to = phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
  const from = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || "+14155238886"}`;

  try {
    const msg = await twilioClient.messages.create({ from, to, body: message });
    return { sid: msg.sid, status: msg.status };
  } catch (err) {
    return { error: err.message };
  }
}

async function notifyOperator(deal, client, invoice) {
  const msg = [
    `NEW INTAKE — The Milano Seal™`,
    `Deal: ${deal.id}`,
    `Invoice: ${invoice.number}`,
    `Client: ${client.name}`,
    `Value: $${deal.total_price}`
  ].join("\n");

  return sendWhatsApp(process.env.OPERATOR_WHATSAPP, msg);
}

// ── FOLLOW UPS ─────────────────────────────────────────────────────
function scheduleFollowUps(dealId, phone, name, total) {
  setTimeout(() => {
    sendWhatsApp(phone, `Follow-up: $${total} still pending`);
  }, 24 * 60 * 60 * 1000);
}

// ── POST /api/intake ───────────────────────────────────────────────
app.post("/api/intake", async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      document_type,
      destination_country,
      urgency = "standard"
    } = req.body;

    if (!name || !email || !document_type) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const tier = suggestTier({ urgency });
    const pricing = calculatePrice({ tier });

    const { data: client } = await supabase
      .from("clients")
      .insert([{
        name,
        email,
        phone: phone || null
      }])
      .select()
      .single();

    const invoiceNum = genInvoiceNumber();

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

    notifyOperator(deal, { name, email, phone }, invoice);

    if (phone) {
      scheduleFollowUps(deal.id, phone, name, pricing.total);
    }

    res.json({
      success: true,
      deal_id: deal.id,
      invoice_number: invoiceNum,
      pricing
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── GET DEALS ──────────────────────────────────────────────────────
app.get("/api/deals", async (_req, res) => {
  const { data } = await supabase
    .from("deals")
    .select("*")
    .limit(50);

  res.json(data);
});

// ── START SERVER ───────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
