// Onde ficam os arquivos que precisam sobreviver ao proximo deploy.
//
// Mora sozinho, fora do db.js, porque quem so precisa saber ONDE gravar nao
// deveria ter que abrir o banco pra descobrir: o leitor da FontesLog roda em
// script de linha de comando e, importando o db.js, criaria um orders.sqlite
// na maquina de quem operou so pra ler um caminho.
//
// O disco do container no Railway e efemero: tudo que estiver fora de um Volume
// some a cada deploy. A ordem abaixo tenta o caminho seguro primeiro:
//
//   1. DATA_DIR                   -- voce mandou explicitamente; manda mais que tudo.
//   2. RAILWAY_VOLUME_MOUNT_PATH  -- o Railway define sozinho quando ha um Volume
//      anexado ao servico. Usar isso significa que os arquivos caem no volume sem
//      ninguem precisar lembrar de configurar variavel nenhuma.
//   3. a pasta data/ do projeto   -- o padrao de quando se roda local.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const dataDir = path.resolve(
  process.env.DATA_DIR ||
    process.env.RAILWAY_VOLUME_MOUNT_PATH ||
    path.join(__dirname, "..", "..", "data")
);

// De onde veio o caminho -- o server usa isso pra avisar, na subida, se o banco
// esta num lugar que nao sobrevive ao proximo deploy.
export const dataDirSource = process.env.DATA_DIR
  ? "DATA_DIR"
  : process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? "RAILWAY_VOLUME_MOUNT_PATH"
    : "padrao-local";

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
