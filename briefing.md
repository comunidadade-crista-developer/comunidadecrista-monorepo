# Documento 1 — Briefing Refatorado Final

**Projeto**: Comunidade Cristã
**Autor original**: Gekko Dreamers
**Versão**: 1.0 (fechada)
**Licença**: AGPL-3.0
**Estado**: Aprovado para arquitectura

---

## 1. Visão

Construir uma aplicação **offline-first** para a comunidade cristã, com foco no estudo dos ensinamentos de Cristo a partir dos Evangelhos, na partilha de entendimentos pessoais e na comunhão entre irmãos. O projeto é **open source**, **sem fins lucrativos**, e **não recolhe dados pessoais** além do estritamente necessário para autenticação.

## 2. Princípios

1. **Offline-first**: a app funciona na maioria do tempo sem rede. Publicações e leituras são suportadas offline; sincronização acontece quando há conectividade.
2. **Privacidade por omissão**: sem email, sem nome real, sem rastreio, sem analytics de terceiros.
3. **Custo zero**: toda a infraestrutura corre em tiers gratuitos.
4. **Simplicidade operacional**: um único backend, um único frontend, sem micro-serviços no MVP.
5. **Linguagem do público**: terminologia evangélica natural, sem jargão técnico nem emojis. Ícones SVG (Lucide/Tabler).
6. **Acessível**: PWA instalável, contraste adequado, tamanhos de toque confortáveis.

## 3. Público-alvo

Cristãos evangélicos de língua portuguesa (PT-PT), com literacia digital variada. Idade mínima: **13 anos**.

## 4. Âmbito do produto

### 4.1 Fluxos de entrada

| Ecrã | Descrição |
|---|---|
| **Splash** | Efeito typewriter com "COMUNIDADE CRISTÃ" ao centro; footer "Por Gekko Dreamers". |
| **Vídeo introdutório** | Vídeo de ~2 min (criação → nascimento de Cristo) em ecrã inteiro na primeira abertura. Botão "Saltar" após 3s (canto superior direito). **Incluído no bundle** da app, offline. |
| **Login** | Logo + nome; campos *nome de utilizador* e *palavra-passe*; links para *esqueceu a palavra-passe* e *criar conta*. Footer "Por Gekko Dreamers". |
| **Registo** | Logo; nome de utilizador; palavra-passe (6–20); confirmação; **três perguntas de recuperação** (cor favorita, número favorito ≤ 999, nome da igreja — todas em minúsculas); aviso de que os dados servem para recuperação; botão "Criar conta" desabilitado até preenchimento completo; anti-duplo-clique. **Código de recuperação** gerado no servidor e mostrado uma única vez após registo. |
| **Recuperação de palavra-passe** | Fluxo com duas vias: (a) **código de recuperação** (primário); (b) três perguntas de segurança (secundário). Após validação, definir nova palavra-passe e redireccionar para login. |

**Estados de loading comuns a login/registo/recuperação**: mensagens progressivas — *"A contactar o servidor…"* → *"A tentar acordar o servidor…"* → *"A sincronizar…"* → *"Conta criada"* / *"Sessão iniciada"*. Se o utilizador fechar e reabrir a app durante o loading, o estado é retomado (não permite nova submissão).

### 4.2 App autenticada

**Header fixo** (todas as telas): logo + nome; ícone de tema (claro/escuro); ícone de suporte.

**Barra de navegação fixa** (todas as telas): *Início*, *Ensinamentos de Cristo*, *Explorar*, *Perfil*, *Contribuir*.

**Início**
- Hero com thumbnail do vídeo introdutório (sem autoplay; clique abre em ecrã inteiro com controlos básicos).
- **Card: Ensinamentos de Cristo** — "Novo Testamento (Mateus, Marcos, Lucas e João). Partilha o teu entendimento. Edifica-te com o entendimento dos irmãos." CTA: *Deixar o teu entendimento*.
- **Card: Explorar** — feed da comunhão. CTA: *Ver a comunhão*.
- **Área de apoio** — "Apoia-nos a manter esta obra acessível a todos. Há várias formas de contribuir." CTA: *Como contribuir*.

**Ensinamentos de Cristo**
- Área de apoio (CTA para contribuir).
- Título "Os Ensinamentos de Cristo"; barra de pesquisa.
- Lista de cards (um por passagem), cada card com: título (ex.: *O Nascimento de Jesus*), referência (ex.: *Mateus 2*), resumo (2–3 linhas), estado (lido / deixou entendimento), botão *Estudar*.

**Ecrã de estudo**
- Título do card; referências do Antigo e Novo Testamento (apenas referências, sem texto bíblico integral — ver §7).
- Botão 1: *Deixar o teu entendimento*.
- Botão 2: *Ler os entendimentos dos irmãos*.

**Deixar entendimento** (composer tipo Facebook)
- Nome do utilizador; título pré-preenchido com o card; placeholder de conteúdo; botão *Publicar* ativo com ≥ 1 caractere.
- Ao publicar offline: o post entra na fila (Aguardando envio) e o utilizador é redireccionado para os entendimentos da passagem.
- Nota: *Vê e gere as tuas partilhas no teu perfil.*

**Comunhão dos irmãos sobre [passagem]**
- Filtros: *Mais recente*, *Mais amados*, *Que eu amei*.
- Primeiro item fixo: o post do próprio utilizador (com estado *Publicado* / *Aguardando envio* / *Em revisão*).
- Restantes posts, por ordem do filtro.
- Cada post: título, autor, data, conteúdo; ações — *Denunciar*, *Amém*, *Partilhar* (redes sociais ou copiar).

**Explorar**
- Área de apoio; título "Comunhão dos irmãos"; botão *Criar partilha*.
- Filtro por área: *Ensinamentos*, *Letras de canções*, *Entendimentos*. Por omissão: Ensinamentos.
- Filtros de ordenação: *Mais recente*, *Mais amados*, *Que eu amei*.
- Composer de criação: título, categoria (Ensinamentos / Letras de canções), conteúdo.

**Perfil**
- Avatar gerado (iniciais + cor determinística a partir do username); alterar nome de utilizador.
- Card: *Total de partilhas* + *Ver todas* → ecrã de gestão com pesquisa e estado por post (Publicado / Aguardando envio / Em revisão).
- Card: *As tuas denúncias* — Abertas / Fechadas + *Ver todas*. Em abertas: cancelar denúncia.
- *Alterar palavra-passe* (palavra-passe atual, nova, confirmação).
- Footer "Por Gekko Dreamers".

**Contribuir**
- Intro: *"A melhor forma de contribuir é usar o projeto da forma correta e ajudar a denunciar partilhas que não fazem parte da nossa doutrina."*
- Formas de contribuir:
  - **Técnica** — link para o GitHub e email de contacto.
  - **Sugestões e bugs** — email.
  - **Financeira** — dados bancários servidos por variáveis de ambiente (nunca hardcoded no frontend público).

**Suporte**
- *Fala connosco* (email).
- *Ajuda a contribuir com o projeto*.
- *FAQ* — como funcionam as denúncias, privacidade, etc.

**Denúncias**
- 1 denúncia por utilizador por post (constraint única).
- Ao atingir **10 denúncias distintas** o post passa a *Em revisão* (oculto do feed público, visível para o autor e para o admin).
- Sem auto-denúncia.
- Anti-abuso: contas com menos de 7 dias ou sem qualquer partilha **não contam** para o limiar.
- Admin revê, aprova ou rejeita com motivo registado em `moderation_log`.

**Admin (web, mesma app, rota `/admin`, protegida por role)**
- Autenticação com role `admin`; middleware de autorização.
- Lista de posts em revisão; aprovar/rejeitar com motivo.
- Lista de denúncias.
- Registo de auditoria.

### 4.3 Comportamento offline

- **Autenticação offline**: primeiro login exige rede. Após login, o dispositivo guarda o `refresh_token` em armazenamento seguro e um **hash argon2id do password gerado localmente** para validação offline. Offline, o utilizador acede aos dados cacheados; ações de escrita ficam em fila.
- **Leitura offline**: cards de ensinamentos, posts vistos recentemente e feeds são cacheados pelo service worker (estratégias stale-while-revalidate e cache-first conforme o recurso).
- **Escrita offline**: todas as criações, amém, denúncias e cancelamentos entram numa **outbox local** (IndexedDB via Dexie) com chave de idempotência. Sincronizam via `POST /sync` quando há rede, com retry exponencial.
- **Estado visível**: cada item pendente mostra *Aguardando envio*; o utilizador pode cancelar antes de sincronizar.

## 5. Linguagem e terminologia

| Conceito | Termo adotado |
|---|---|
| Publicação / post | **Partilha** |
| Feed | **Comunhão** |
| Curtir / like | **Amém** |
| Deixar entendimento | **Deixar o teu entendimento** |
| Ver posts de outros | **Ler os entendimentos dos irmãos** |
| Estado pendente | **Aguardando envio** |
| Estado em revisão | **Em revisão pela equipa** |
| Apoiar financeiramente | **Semear nesta obra** |

**Glossário de referência**: irmãos, Palavra, versículo, passagem, meditar, edificação, exortação, comunhão, testemunho, entendimento, amém, graça e paz.

**Regras de estilo**:
- PT-PT.
- Sem emojis. Ícones SVG (Lucide ou Tabler).
- Tom sóbrio, sem marketing agressivo nem linguagem de prosperidade.

## 6. Fora de âmbito (MVP)

- Notificações push (só in-app no MVP).
- Chat / mensagens diretas.
- Upload de foto de perfil (avatar gerado apenas).
- Múltiplas traduções bíblicas.
- Aplicações nativas nas lojas (PWA apenas no MVP; TWA mais tarde se necessário).
- Comentários em partilhas.
- Seguir utilizadores.

## 7. Restrições legais e técnicas

- **Bíblia**: apenas **referências** (livro, capítulo, versículo) e resumo próprio. Sem texto bíblico integral de traduções licenciadas.
- **Sem email de utilizador**: recuperação por código + perguntas. Consequência aceite: sem verificação de conta por email.
- **Dados pessoais**: username, hash de password, hashes das respostas de segurança, hash do código de recuperação. Sem IP, sem user-agent persistido.
- **Idade mínima**: 13 anos; aviso no registo.
- **Direito ao apagamento**: apagar conta → soft-delete + purga após 30 dias.
- **Licença**: AGPL-3.0.

## 8. Critérios de sucesso do MVP

1. Um utilizador consegue registar-se, autenticar-se, recuperar a conta e publicar entendimentos — offline e online.
2. Nenhuma perda de dados em cenários de rede intermitente.
3. Toda a infraestrutura corre em tiers gratuitos sem expiração.
4. Admin consegue moderar posts denunciados.
5. Linguagem e UX coerentes com o público-alvo (validado por 3–5 utilizadores reais).
