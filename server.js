const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'vintage',
    decimalNumbers: true,
    connectionLimit: 10
});

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const digits = v => String(v || '').replace(/\D/g, '');
const q = async (sql, p = []) => (await pool.query(sql, p))[0];
const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
        if (e.status) return res.status(e.status).json({ erro: e.message });
        if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Registro duplicado (CPF, CNPJ ou conta já cadastrado).' });
        if (e.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ erro: 'Referência inválida (categoria, loja ou fornecedor).' });
        console.error(e);
        res.status(500).json({ erro: 'Erro interno do servidor' });
    }
};
const newConta = async (c, prefix) => {
    const [r] = await c.query('INSERT INTO conta (numero) VALUES (?)', [`${prefix}-${Date.now()}${Math.floor(Math.random() * 900 + 100)}`]);
    return r.insertId;
};
const tx = async fn => {
    const c = await pool.getConnection();
    try { await c.beginTransaction(); const r = await fn(c); await c.commit(); return r; }
    catch (e) { await c.rollback(); throw e; }
    finally { c.release(); }
};

// ---------- Clientes ----------
app.get('/api/clientes', wrap(async (_, res) =>
    res.json(await q('SELECT id_cliente id, nome, cpf, email, telefone FROM cliente ORDER BY id_cliente'))));
app.post('/api/clientes', wrap(async (req, res) => {
    const { nome, cpf, email, telefone } = req.body;
    if (!nome?.trim()) throw bad('Nome é obrigatório.');
    if (digits(cpf).length !== 11) throw bad('CPF inválido (11 dígitos).');
    const id = await tx(async c => {
        const conta = await newConta(c, 'C');
        const [r] = await c.query('INSERT INTO cliente (nome,cpf,email,telefone,id_conta) VALUES (?,?,?,?,?)',
            [nome.trim(), cpf.trim(), email || null, telefone || null, conta]);
        return r.insertId;
    });
    res.status(201).json({ id });
}));

// ---------- Lojas ----------
app.get('/api/lojas', wrap(async (_, res) =>
    res.json(await q('SELECT id_loja id, nome, tipo, endereco FROM loja ORDER BY id_loja'))));
app.post('/api/lojas', wrap(async (req, res) => {
    const { nome, tipo, endereco } = req.body;
    if (!nome?.trim()) throw bad('Nome é obrigatório.');
    if (!['Física', 'Online'].includes(tipo)) throw bad('Tipo inválido.');
    const id = await tx(async c => {
        const conta = await newConta(c, 'L');
        const [r] = await c.query('INSERT INTO loja (nome,tipo,endereco,id_conta) VALUES (?,?,?,?)',
            [nome.trim(), tipo, endereco || null, conta]);
        return r.insertId;
    });
    res.status(201).json({ id });
}));

// ---------- Categorias ----------
app.get('/api/categorias', wrap(async (_, res) =>
    res.json(await q('SELECT id_categoria id, nome, descricao FROM categoria ORDER BY id_categoria'))));
app.post('/api/categorias', wrap(async (req, res) => {
    if (!req.body.nome?.trim()) throw bad('Nome é obrigatório.');
    const r = await q('INSERT INTO categoria (nome,descricao) VALUES (?,?)', [req.body.nome.trim(), req.body.descricao || null]);
    res.status(201).json({ id: r.insertId });
}));

// ---------- Fornecedores (RN03) ----------
app.get('/api/fornecedores', wrap(async (_, res) =>
    res.json(await q('SELECT id_fornecedor id, razao_social, cnpj, email, telefone FROM fornecedor ORDER BY id_fornecedor'))));
app.post('/api/fornecedores', wrap(async (req, res) => {
    const { razao_social, cnpj, email, telefone } = req.body;
    if (!razao_social?.trim()) throw bad('Razão social é obrigatória.');
    if (digits(cnpj).length !== 14) throw bad('CNPJ inválido (14 dígitos).');
    const r = await q('INSERT INTO fornecedor (razao_social,cnpj,email,telefone) VALUES (?,?,?,?)',
        [razao_social.trim(), cnpj.trim(), email || null, telefone || null]);
    res.status(201).json({ id: r.insertId });
}));

// ---------- Produtos + Estoque ----------
app.get('/api/produtos', wrap(async (_, res) => res.json(await q(`
    SELECT p.id_produto id, p.nome, p.id_categoria categoria, p.id_loja loja, p.preco,
           p.tendencia, p.novidade, MIN(e.id_fornecedor) fornecedor,
           CAST(COALESCE(SUM(e.quantidade),0) AS SIGNED) estoque
    FROM produto p LEFT JOIN estoque e ON e.id_produto = p.id_produto
    GROUP BY p.id_produto ORDER BY p.id_produto`))));
app.post('/api/produtos', wrap(async (req, res) => {
    const { nome, categoria, loja, preco, estoque, fornecedor, tendencia, novidade } = req.body;
    if (!nome?.trim() || !categoria || !loja) throw bad('Nome, categoria e loja são obrigatórios.');
    if (!(Number(preco) >= 0)) throw bad('Preço inválido.');
    if (!fornecedor) throw bad('Selecione o fornecedor (RN03).');
    const qty = Math.max(0, parseInt(estoque) || 0);
    const id = await tx(async c => {
        const [r] = await c.query(
            'INSERT INTO produto (nome,tendencia,novidade,preco,id_categoria,id_loja) VALUES (?,?,?,?,?,?)',
            [nome.trim(), tendencia ? 1 : 0, novidade ? 1 : 0, Number(preco), categoria, loja]);
        await c.query('INSERT INTO estoque (id_produto,id_fornecedor,quantidade) VALUES (?,?,?)', [r.insertId, fornecedor, qty]);
        return r.insertId;
    });
    res.status(201).json({ id });
}));

// ---------- Vendas (RF04, RF05, RN01, RN02) ----------
app.get('/api/vendas', wrap(async (_, res) => res.json(await q(`
    SELECT id_venda id, data, id_cliente cliente, id_loja loja, canal, valor_total total, status
    FROM venda ORDER BY id_venda`))));
app.post('/api/vendas', wrap(async (req, res) => {
    const { cliente, loja, canal, forma, itens, valorPago } = req.body;
    if (!cliente || !loja) throw bad('Selecione cliente e loja.');
    if (!['PIX', 'Cartão', 'Boleto'].includes(forma)) throw bad('Forma de pagamento inválida.');
    if (!Array.isArray(itens) || !itens.length) throw bad('Adicione ao menos um item.');

    const merged = {};
    for (const i of itens) {
        const qty = parseInt(i.quantidade);
        if (!i.produto || !(qty > 0)) throw bad('Item inválido.');
        merged[i.produto] = (merged[i.produto] || 0) + qty;
    }

    const result = await tx(async c => {
        const lines = []; let total = 0;
        for (const [produto, qty] of Object.entries(merged)) {
            const [[row]] = await c.query(`
                SELECT p.nome, p.preco, e.id_estoque, e.quantidade
                FROM produto p JOIN estoque e ON e.id_produto = p.id_produto
                WHERE p.id_produto = ? ORDER BY e.quantidade DESC LIMIT 1 FOR UPDATE`, [produto]);
            if (!row) throw bad(`Produto ${produto} sem estoque cadastrado.`);
            if (row.quantidade < qty) throw bad(`Estoque insuficiente para "${row.nome}". Disponível: ${row.quantidade}`, 409); // RN01
            lines.push({ produto, qty, ...row });
            total += qty * row.preco;
        }
        total = Math.round(total * 100) / 100;
        const [v] = await c.query('INSERT INTO venda (valor_total,canal,status,id_cliente,id_loja) VALUES (?,?,?,?,?)',
            [total, canal || 'Loja física', 'ABERTA', cliente, loja]);
        for (const l of lines) {
            await c.query('INSERT INTO item_venda (id_venda,id_produto,id_estoque,quantidade,preco_unitario) VALUES (?,?,?,?,?)',
                [v.insertId, l.produto, l.id_estoque, l.qty, l.preco]);
            await c.query('UPDATE estoque SET quantidade = quantidade - ? WHERE id_estoque = ?', [l.qty, l.id_estoque]);
        }
        const pago = (valorPago === undefined || valorPago === null || valorPago === '') ? total : Math.round(Number(valorPago) * 100) / 100;
        if (!(pago > 0) || pago > total) throw bad('Valor pago inválido.');
        await c.query('INSERT INTO pagamento (id_venda,forma,valor,status) VALUES (?,?,?,?)', [v.insertId, forma, pago, 'CONCLUIDO']);
        // RN02: soma dos pagamentos = valor_total → CONCLUIDO
        const [[s]] = await c.query('SELECT SUM(valor) soma FROM pagamento WHERE id_venda = ?', [v.insertId]);
        if (Math.abs(s.soma - total) < 0.005) {
            await c.query("UPDATE venda SET status='CONCLUIDO' WHERE id_venda = ?", [v.insertId]);
            await c.query('UPDATE conta c JOIN loja l ON l.id_conta = c.id_conta SET c.saldo = c.saldo + ? WHERE l.id_loja = ?', [total, loja]);
        }
        return { id: v.insertId, total };
    });
    res.status(201).json(result);
}));

// ---------- Pagamentos ----------
app.get('/api/pagamentos', wrap(async (_, res) => res.json(await q(
    'SELECT id_pagamento id, id_venda venda, forma, valor, status, data FROM pagamento ORDER BY id_pagamento'))));


// ============ NOVAS ROTAS ============
const FORMAS = ['PIX', 'Cartão', 'Boleto'];

// Contas financeiras (RF01)
app.get('/api/contas', wrap(async (_, res) => res.json(await q(`
    SELECT 'Loja' tipo, l.nome, c.numero, c.saldo FROM loja l JOIN conta c ON c.id_conta = l.id_conta
    UNION ALL
    SELECT 'Cliente', cl.nome, c.numero, c.saldo FROM cliente cl JOIN conta c ON c.id_conta = cl.id_conta`))));

// Entrada de estoque em produto existente (RF03 / CU-002)
app.post('/api/estoque', wrap(async (req, res) => {
    const { produto, fornecedor } = req.body, qty = parseInt(req.body.quantidade);
    if (!produto || !fornecedor || !(qty > 0)) throw bad('Informe produto, fornecedor e quantidade positiva.');
    const [e] = await q('SELECT id_estoque FROM estoque WHERE id_produto=? AND id_fornecedor=? LIMIT 1', [produto, fornecedor]);
    if (e) await q('UPDATE estoque SET quantidade = quantidade + ? WHERE id_estoque = ?', [qty, e.id_estoque]);
    else await q('INSERT INTO estoque (id_produto,id_fornecedor,quantidade) VALUES (?,?,?)', [produto, fornecedor, qty]);
    res.status(201).json({ ok: true });
}));

// Vendas em aberto (CU-003)
app.get('/api/vendas/abertas', wrap(async (_, res) => res.json(await q(`
    SELECT v.id_venda id, c.nome cliente, v.valor_total total, COALESCE(SUM(p.valor),0) pago,
           v.valor_total - COALESCE(SUM(p.valor),0) restante
    FROM venda v JOIN cliente c ON c.id_cliente = v.id_cliente
    LEFT JOIN pagamento p ON p.id_venda = v.id_venda
    WHERE v.status = 'ABERTA' GROUP BY v.id_venda, c.nome, v.valor_total ORDER BY v.id_venda`))));

// Liquidar pagamento, inclusive parcial (CU-003 / RN02)
app.post('/api/pagamentos', wrap(async (req, res) => {
    const { venda, forma } = req.body, valor = Math.round(Number(req.body.valor) * 100) / 100;
    if (!FORMAS.includes(forma)) throw bad('Forma de pagamento inválida.');
    if (!(valor > 0)) throw bad('Valor inválido.');
    const r = await tx(async c => {
        const [[v]] = await c.query('SELECT valor_total, status, id_loja FROM venda WHERE id_venda = ? FOR UPDATE', [venda]);
        if (!v) throw bad('Venda não encontrada.', 404);
        if (v.status === 'CONCLUIDO') throw bad('Venda já quitada.', 409);
        const [[s]] = await c.query('SELECT COALESCE(SUM(valor),0) soma FROM pagamento WHERE id_venda = ?', [venda]);
        const rest = Math.round((v.valor_total - s.soma) * 100) / 100;
        if (valor > rest) throw bad(`Valor maior que o restante (R$ ${rest.toFixed(2)}).`);
        await c.query('INSERT INTO pagamento (id_venda,forma,valor,status) VALUES (?,?,?,?)', [venda, forma, valor, 'CONCLUIDO']);
        if (valor === rest) {
            await c.query("UPDATE venda SET status='CONCLUIDO' WHERE id_venda = ?", [venda]);
            await c.query('UPDATE conta c JOIN loja l ON l.id_conta = c.id_conta SET c.saldo = c.saldo + ? WHERE l.id_loja = ?', [v.valor_total, v.id_loja]);
        }
        return { restante: Math.round((rest - valor) * 100) / 100 };
    });
    res.status(201).json(r);
}));

// Extrato do cliente
app.get('/api/clientes/:id/extrato', wrap(async (req, res) => {
    const [conta] = await q('SELECT c.numero, c.saldo FROM cliente cl JOIN conta c ON c.id_conta = cl.id_conta WHERE cl.id_cliente = ?', [req.params.id]);
    if (!conta) throw bad('Cliente não encontrado.', 404);
    const vendas = await q(`
        SELECT v.id_venda id, v.data, l.nome loja, v.valor_total total, COALESCE(SUM(p.valor),0) pago, v.status
        FROM venda v JOIN loja l ON l.id_loja = v.id_loja LEFT JOIN pagamento p ON p.id_venda = v.id_venda
        WHERE v.id_cliente = ? GROUP BY v.id_venda, l.nome ORDER BY v.id_venda DESC`, [req.params.id]);
    res.json({ conta, vendas });
}));

// Relatórios
app.get('/api/relatorios', wrap(async (_, res) => {
    const [[resumo]] = await pool.query('SELECT COUNT(*) vendas, COALESCE(SUM(valor_total),0) faturamento, COALESCE(AVG(valor_total),0) ticket FROM venda');
    const [[rec]] = await pool.query('SELECT COALESCE(SUM(valor),0) recebido FROM pagamento');
    res.json({
        ...resumo, ...rec,
        porForma: await q('SELECT forma, SUM(valor) total FROM pagamento GROUP BY forma'),
        porLoja: await q('SELECT l.nome, COUNT(v.id_venda) vendas, COALESCE(SUM(v.valor_total),0) total FROM loja l LEFT JOIN venda v ON v.id_loja = l.id_loja GROUP BY l.id_loja, l.nome'),
        topProdutos: await q('SELECT p.nome, SUM(i.quantidade) qtd, SUM(i.quantidade * i.preco_unitario) total FROM item_venda i JOIN produto p ON p.id_produto = i.id_produto GROUP BY p.id_produto, p.nome ORDER BY qtd DESC LIMIT 5')
    });
}));

app.listen(port, () => console.log(`Servidor rodando em http://localhost:${port}/`));