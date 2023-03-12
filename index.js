const express = require("express");
const mercadopago = require("mercadopago")
const { postgraphile } = require("postgraphile");


const userDb = "alex";
const userPass = 1234;
const host = "localhost";
const database = "BBDD_Funko";

async function ConfirmaCarrito(dni) {
  const response = await fetch('http://localhost:5000/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
          query: `mutation {
              confirmarComprarDelCarrito(input: {dniUser: ${dni}}) {
                clientMutationId
              }
            }
            
            `
      }),
    })

    const respuesta = await response.json()
    console.log(respuesta)

}

async function ConfirmaVenta(dni) {
  const response = await fetch('http://localhost:5000/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
          query: `mutation {
              confirmarEstadoDeVenta(input: {dni: ${dni}}) {
                clientMutationId
              }
            }
            
            `
      }),
    })

    const respuesta = await response.json()
    console.log(respuesta)

}


async function getDataUser(email) {
  const response = await fetch('http://localhost:5000/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
          query: `query MyQuery {
              usuarioByEmail(email: "${email}") {
                dni
              }
            }
            
            `
      }),
    })

    const respuesta = await response.json()
    return respuesta.data.usuarioByEmail;

}


/*1Backend 2 ngrok=port 5000 */
const {
  MySchemaCategoriasPlugins,
} = require("./Schemas/Categorias/Categorias.js");
const app = express();



app.post("/notificar", async (req, res) => {
  await notificar(req, res);
});

const notificar = async (req, res) => {
  try {
    mercadopago.configure({
      access_token:
        "TEST-5873713881795945-030921-d57166b7b2e69778a0aee6a8bca9190b-1327386578",
    });

    const { query } = req;

    let payment;

    const topic = query.topic || query.type;

    if (topic == "payment") {
      const paymentId = query.id || query["data.id"];
      payment = await mercadopago.payment.findById(paymentId);

      
      console.log(payment)
      const items = payment.body.additional_info.items;
      const status = payment.body.status;
      const email = payment.body.metadata.id_user;
      console.log(status,paymentId)
      
      /* TODO: Buscar como ver los pagos anteriores */
       /*FUnciones bases de datos */
       /*if (status === "approved") {
        const data_user = await getDataUser(email)
        console.log(data_user.dni)  
        console.log("Carritoooo")
        await ConfirmaCarrito(data_user.dni)
        console.log("VENTAAAAA")   
        await ConfirmaVenta(data_user.dni) 
      }
      else{
        console.log("Compra no aprovada")
      }
     */
      
      res.status(200);
    } else {
      res.status(400);
    }
  } catch (err) {
    console.log(err);
    return err;
  }
};

app.use(
  postgraphile(
    `postgres://${userDb}:${userPass}@${host}/${database}` ||
      "postgres://postgres:postgres@127.0.0.1:5432/name-databases",
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
  const port = 5000;
  await app.listen(port);
  console.log(`Conectado pa http://localhost:${port}/graphiql`);
};

main();
