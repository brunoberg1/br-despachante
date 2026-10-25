
import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use a chave de teste da Carpédia no Render.
// Opcional: defina CARPEDIA_API_BASE_URL nas variáveis de ambiente.
const CARPEDIA_BASE_URL =
  process.env.CARPEDIA_API_BASE_URL ||
  "https://www.carpedia.com.br/api/sandbox/v1";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json({
    nome: "BR Despachante",
    servidor: "online",
    consultasConfiguradas: Boolean(process.env.CARPEDIA_API_KEY),
    ambiente: "sandbox",
    pagamentosPix: false
  });
});

app.post("/api/consultas/agregados", async (req, res) => {
  const placa = String(req.body?.placa || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa)) {
    return res.status(400).json({
      erro: "Digite uma placa válida. Exemplo: ABC1D23."
    });
  }

  const apiKey = process.env.CARPEDIA_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      erro: "Consulta indisponível: a chave da API não está configurada."
    });
  }

  try {
    const resposta = await fetch(
      `${CARPEDIA_BASE_URL}/consultas/agregados`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({ placa })
      }
    );

    const texto = await resposta.text();
    let dados;

    try {
      dados = texto ? JSON.parse(texto) : {};
    } catch {
      dados = { mensagem: "A API retornou uma resposta não JSON." };
    }

    if (!resposta.ok) {
      console.error("Erro da API Carpédia:", resposta.status);

      return res.status(502).json({
        erro: "A consulta não pôde ser concluída. Tente novamente mais tarde.",
        statusFornecedor: resposta.status
      });
    }

    return res.status(200).json({
      mensagem: "Solicitação enviada à API de teste.",
      ambiente: "sandbox",
      statusFornecedor: resposta.status,
      acompanhamento: resposta.headers.get("Location"),
      resultado: dados
    });
  } catch (erro) {
    console.error("Falha ao acessar a API Carpédia:", erro.message);

    return res.status(502).json({
      erro: "Não foi possível conectar à API. Tente novamente mais tarde."
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BR Despachante iniciado na porta ${PORT}`);
});
        
