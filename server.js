
import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});
async function inicializarBanco() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id BIGSERIAL PRIMARY KEY,
      pagamento_id TEXT UNIQUE,
      cliente_nome TEXT,
      cliente_email TEXT,
      placa TEXT,
      servico TEXT NOT NULL,
      valor_centavos INTEGER NOT NULL,
      status_pagamento TEXT NOT NULL DEFAULT 'PENDENTE',
      status_consulta TEXT NOT NULL DEFAULT 'AGUARDANDO',
      pedido_fornecedor_id TEXT,
      resultado JSONB,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS eventos_asaas (
      id BIGSERIAL PRIMARY KEY,
      evento_id TEXT UNIQUE NOT NULL,
      tipo_evento TEXT NOT NULL,
      recebido_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("Banco de dados preparado.");
}

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const ASAAS_BASE_URL =
  process.env.ASAAS_BASE_URL ||
  "https://api-sandbox.asaas.com/v3";

const CARPEDIA_BASE_URL =
  process.env.CARPEDIA_API_BASE_URL ||
  "https://www.carpedia.com.br/api/sandbox/v1";

// Preços definidos no servidor. O navegador não pode escolher o valor.
const SERVICOS = {
  basicos: { nome: "Dados básicos", valor: 9.90 },
  gravame: { nome: "Gravame", valor: 14.90 },
  restricoes: { nome: "Restrições nacionais", valor: 19.90 },
  roubo_furto: { nome: "Roubo e furto", valor: 19.90 },
  sinistro: { nome: "Indício de sinistro", valor: 24.90 },
  leilao: { nome: "Consulta de leilão", valor: 34.90 },
  completa: { nome: "Consulta completa", valor: 49.90 }
};

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(ROOT, "public")));

async function asaasRequest(endpoint, method = "GET", body) {
  const apiKey = process.env.ASAAS_API_KEY;

  if (!apiKey) {
    throw new Error("A variável ASAAS_API_KEY não está configurada no Render.");
  }

  const response = await fetch(`${ASAAS_BASE_URL}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "access_token": apiKey
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

if (!response.ok) {
  console.error("Erro Asaas:", response.status, JSON.stringify(data));
  throw new Error(
    `Asaas HTTP ${response.status}: ${
      data.errors?.map(e => e.description).join("; ") ||
      data.message ||
      "Erro sem descrição"
    }`
  );
}

  return data;
}

app.get("/api/status", (req, res) => {
  res.json({
    nome: "BR Despachante",
    servidor: "online",
    pagamentosConfigurados: Boolean(process.env.ASAAS_API_KEY),
    ambiente: ASAAS_BASE_URL.includes("sandbox") ? "sandbox" : "produção",
    consultasConfiguradas: Boolean(process.env.CARPEDIA_API_KEY),
    pagamentosPix: true
  });
});

// Cria uma cobrança Pix de teste e devolve os dados do QR Code.
app.post("/api/pagamentos/pix", async (req, res) => {
  try {
    const nome = String(req.body?.nome || "").trim();
    const cpf = String(req.body?.cpf || "").replace(/\D/g, "");
    const email = String(req.body?.email || "").trim();
    const placa = String(req.body?.placa || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    const servicoId = String(req.body?.servico || "");
    const servico = SERVICOS[servicoId];

    if (nome.length < 3) {
      return res.status(400).json({ erro: "Informe seu nome completo." });
    }

    if (cpf.length !== 11) {
      return res.status(400).json({ erro: "Informe um CPF com 11 números." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ erro: "Informe um e-mail válido." });
    }

    if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa)) {
      return res.status(400).json({ erro: "Informe uma placa válida. Exemplo: ABC1D23." });
    }

    if (!servico) {
      return res.status(400).json({ erro: "Selecione um serviço válido." });
    }

    const referencia = `BRD-${crypto.randomUUID()}`;

    // Cria o cliente no Asaas.
    const cliente = await asaasRequest("/customers", "POST", {
      name: nome,
      cpfCnpj: cpf,
      email,
      externalReference: referencia
    });

    // Cria a cobrança Pix com o preço definido no servidor.
    const cobranca = await asaasRequest("/payments", "POST", {
      customer: cliente.id,
      billingType: "PIX",
      value: servico.valor,
      dueDate: new Date(Date.now() + 86400000)
        .toISOString()
        .slice(0, 10),
      description: `BR Despachante - ${servico.nome}`,
      externalReference: referencia
    });

    const pix = await asaasRequest(
      `/payments/${encodeURIComponent(cobranca.id)}/pixQrCode`
    );

    return res.status(201).json({
      mensagem: "Cobrança Pix de teste criada.",
      ambiente: ASAAS_BASE_URL.includes("sandbox") ? "sandbox" : "produção",
      referencia,
      pagamentoId: cobranca.id,
      servico: servico.nome,
      valor: servico.valor,
      status: cobranca.status,
      imagemQrCode: pix.encodedImage,
      codigoPix: pix.payload,
      vencimento: pix.expirationDate
    });
  } catch (erro) {
    console.error("Falha ao criar Pix:", erro.message);
    return res.status(502).json({
      erro: "Não foi possível gerar o Pix. Verifique a configuração do Asaas e tente novamente."
    });
  }
});

// Consulta veicular separada. Não é acionada pela criação do Pix.
app.post("/api/consultas/agregados", async (req, res) => {
  const placa = String(req.body?.placa || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa)) {
    return res.status(400).json({ erro: "Digite uma placa válida." });
  }

  const apiKey = process.env.CARPEDIA_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      erro: "Consulta indisponível: API não configurada."
    });
  }

  try {
    const resposta = await fetch(
      `${CARPEDIA_BASE_URL}/consultas/agregados`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({ placa })
      }
    );

    const texto = await resposta.text();
    let dados = {};

    try {
      dados = texto ? JSON.parse(texto) : {};
    } catch {
      dados = { mensagem: "Resposta não JSON." };
    }

    if (!resposta.ok) {
      console.error("Erro Carpédia:", resposta.status);
      return res.status(502).json({
        erro: "A consulta não pôde ser concluída.",
        statusFornecedor: resposta.status
      });
    }

    return res.json({
      ambiente: "sandbox",
      resultado: dados
    });
  } catch (erro) {
    console.error("Falha Carpédia:", erro.message);
    return res.status(502).json({
      erro: "Não foi possível conectar à API de consulta."
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

inicializarBanco()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`BR Despachante iniciado na porta ${PORT}`);
    });
  })
  .catch((erro) => {
    console.error("Erro ao preparar o banco de dados:", erro.message);
    process.exit(1);
  });
      
