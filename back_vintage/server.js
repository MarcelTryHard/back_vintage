const express = require('express');
const mysql = require('mysql2');

const cors = require('cors');

const app = express();
const port = 3000;

// Use o cors
app.use(cors());

// Middleware(ponte) para o Express entender JSON no corpo da requisição (req.body)
app.use(express.json());

// 1. Configura a conexão com o MySQL
const connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'trabalho_vintage'
});

// Conecta ao banco de dados
// connection.connect((err) => {
//     if (err) {
//       console.error('Erro ao conectar ao MySQL: ', err.stack );
//       return;
//     }
//     console.log('Conectado ao MySQL com sucesso!');

//     // Cria a tabela 'alunos'  caso ela não exista
//     const createTableQuery = `
//       CREATE TABLE IF NOT EXISTS cliente(
//         id INT AUTO_INCREMENT PRIMARY KEY,
//         nome VARCHAR(255) NOT NULL
//       )`;
//       connection.query( createTableQuery, (err) => {
//         if (err) {
//           console.error('Erro ao criar tabela: ', err.stack );
//           return;
//         }
//       } );
// });

app.get('/cliente', (req, res) => {
    connection.query('SELECT * FROM cliente', (err, results) => {
        if (err) {
            return res.status(500).json({ erro: 'Erro ao buscar cliente'});
        }
        res.json(results);
    });
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost':${port}/`);
});