const express =  require('express');
const { postgraphile } = require('postgraphile');
const {MySchemaCategoriasPlugins} = require('./Schemas/Categorias/Categorias.js')
const app = express();


const userDb = 'alex'
const userPass = 1234
const host = 'localhost'
const database = 'BBDD_Funko'


app.use(
    postgraphile(
      `postgres://${userDb}:${userPass}@${host}/${database}` || "postgres://postgres:postgres@127.0.0.1:5432/name-databases",
      ["public"],
      {
        watchPg: true,
        graphiql: true,
        enableCors: true,
        enhanceGraphiql: true,
        showErrorStack: true,
        appendPlugins: [MySchemaCategoriasPlugins],
      }
    )
  );

  
const main = async () => {
    const port = 5050;
    await app.listen(port);
    console.log(`Conectado pa http://localhost:${port}/graphiql`);
  }
  
main()