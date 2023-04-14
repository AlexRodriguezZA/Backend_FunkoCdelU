async function ConfirmaCarrito(dni) {
  const response = await fetch("http://localhost:5000/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `mutation {
                confirmarComprarDelCarrito(input: {dniUser: ${dni}}) {
                  clientMutationId
                }
              }
              
              `,
    }),
  });

  const respuesta = await response.json();
  console.log(respuesta);
}

async function ConfirmaVenta(dni, mercadopago_id) {
  const response = await fetch("http://localhost:5000/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `mutation {
          confirmarEstadoDeVenta(input: {dni: ${dni}, mercadopagoId: "${mercadopago_id}"}) {
            clientMutationId
          }
        }
        
              `,
    }),
  });

  const respuesta = await response.json();
  console.log(respuesta);
}

async function getDataUser(email) {
  const response = await fetch("http://localhost:5000/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query MyQuery {
                usuarioByEmail(email: "${email}") {
                  dni
                }
              }
              
              `,
    }),
  });

  const respuesta = await response.json();
  return respuesta.data.usuarioByEmail;
}

async function getMercadoPagoId() {
  const response = await fetch("http://localhost:5000/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query MyQuery {
                      allVentausuarios {
                      nodes {
                      mercadopagoId
            }
          }
        }
        
              
              `,
    }),
  });

  const respuesta = await response.json();
  return respuesta.data.allVentausuarios.nodes;
}
module.exports = {
    ConfirmaCarrito,
    ConfirmaVenta,
    getDataUser,
    getMercadoPagoId
  };