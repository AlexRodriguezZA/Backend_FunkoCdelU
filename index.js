const express = require("express");
const mercadopago = require("mercadopago");
const { postgraphile } = require("postgraphile");
const nodemailer = require("nodemailer");
const multer = require('multer');
const path = require('path');
const Funcion_BBDD = require("./src/BBDD_Function")
const fs = require('fs-extra');

let dotoenv = require("dotenv");


dotoenv.config();

const userDb = process.env.USER_DB;
const userPass = process.env.USER_PASS;
const host = process.env.HOST;
const database = process.env.BBDD;

const app = express();

/*Mandar correo de confirmación al usuario */



const emailHtmlPath = path.join(__dirname, 'email', 'index.html');
const email_html = fs.readFileSync(emailHtmlPath, 'utf8');

const logoPath = path.join(__dirname, 'email', 'logo.png');
const logo = fs.readFileSync(logoPath);
const filePath = path.join(__dirname, 'email', 'funkos parte foot.png');
const Foot = fs.readFileSync(filePath);

async function MandarEmail(email) {
  let mailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_FUNKO,
      pass: process.env.PASS_FUNKO,
    },
  });

  let detalle = {
    from: "funkocdelu@gmail.com",
    to: email,
    subject: "Gracias por su compra",
    html: email_html,
    attachments: [{
      filename: 'logo.png',
      content: logo,
      cid: 'logo'
    }
      ,
    {
      filename: 'funkos parte foot.png',
      content: Foot,
      cid: 'foot'
    }
    
  ]
  };

  mailTransporter.sendMail(detalle, (err) => {
    if (err) {
      console.log("Correo no enviado");
    } else {
      console.log("Correo enviado");
    }
  });
}
/*1Backend 2 ngrok=port 5000 */
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
      //const items = payment.body.additional_info.items;
      const status = payment.body.status;
      const email = payment.body.metadata.id_user;
      console.log(status, paymentId, typeof paymentId);
      
      const IdsMercadopago = await Funcion_BBDD.getMercadoPagoId()
      //FIltramos de los que tiene solo NULL
      let ids = []
      IdsMercadopago.map( (id) => {
        if (id != null){
          ids.push(id)
        }
      })
      console.log(ids)
      
      let IdEncontrado = ids.find( (id) => id.mercadopagoId === paymentId)
      console.log(IdEncontrado, paymentId)

      if (!IdEncontrado) {
        console.log("No exite en la base de datos el id de mercado pago")
        if (status === "approved") {
          const data_user = await Funcion_BBDD.getDataUser(email)
          console.log(data_user.dni)  
          console.log("Carritoooo")
          await Funcion_BBDD.ConfirmaCarrito(data_user.dni)
          console.log("VENTAAAAA")   
          await Funcion_BBDD.ConfirmaVenta(data_user.dni,paymentId)   
          console.log("Emaaaaill")   
          await MandarEmail(email);

        }
        else{
          console.log("Compra no aprobada...")
        }
      }
      else{
        console.log("Compra ya realizada...")
        
      }
      res.status(200);
      
    } else {
      res.status(400);
    }
  } catch (err) {
    console.log(err);
    return err;
  }
};

const CURRENT_DIR = path.dirname(__dirname);
const MIMETYPES = ['image/jpeg', 'image/png','image/jpg','image/webp'];

const multerUpload = multer({
    storage: multer.diskStorage({
        destination: path.join(CURRENT_DIR, '/2_Backend/uploads'),
        filename: (req, file, cb) => {
            const fileExtension = path.extname(file.originalname);
            const fileName = file.originalname.split(fileExtension)[0];

            cb(null, `${fileName}${fileExtension}`);
        },
    }),
    fileFilter: (req, file, cb) => {
        if (MIMETYPES.includes(file.mimetype)) cb(null, true);
        else cb(new Error(`Only ${MIMETYPES.join(' ')} mimetypes are allowed`));
    },
    limits: {
        fieldSize: 10000000,
    },
});


// Ruta que maneja la carga de la imagen 
app.post('/upload', multerUpload.single('image'), async (req, res) => {
  console.log("Imagen recibida",req.file)

  try {
    const imageUrl = req.file.path;
    res.json({ imageUrl });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post("/notificar", async (req, res) => {
  await notificar(req, res);
});

//POdemos servir las imagenes al frontend con esta opcion
//app.use('/public_funko_img', express.static(path.join(CURRENT_DIR, '/2_Backend/uploads')));

const uploadsPath = path.join(__dirname, 'uploads');
app.use('/public_funko_img', express.static(uploadsPath));

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
    }
  )
);

const main = async () => {
  const port = 5000;
  await app.listen(port);
  console.log(`Conectado pa http://localhost:${port}/graphiql`);

  
};

main();
