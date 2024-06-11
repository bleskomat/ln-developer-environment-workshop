const fs = require('fs');
const path = require('path');
const grpc = require('grpc');
const protoLoader = require('@grpc/proto-loader');

const loaderOptions = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
};

const protoFilePath = path.join(__dirname, '../../lib/proto/lnd/0.17.0-beta/lnrpc/lightning.proto');

const packageDefinition = protoLoader.loadSync(protoFilePath, loaderOptions);

process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA'

// TODO: replace admin.macaroon
let m = fs.readFileSync('admin.macaroon');
let macaroon = m.toString('hex');

// build meta data credentials
let metadata = new grpc.Metadata()
metadata.add('macaroon', macaroon)
let macaroonCreds = grpc.credentials.createFromMetadataGenerator((_args, callback) => {
  callback(null, metadata);
});

// build ssl credentials using the cert the same as before
// TODO: replace tls.cert with the correct path.
let lndCert = fs.readFileSync("tls.cert");
let sslCreds = grpc.credentials.createSsl(lndCert);

// combine the cert credentials and the macaroon auth credentials
// such that every call is properly encrypted and authenticated
let credentials = grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds);

// Pass the crendentials when creating a channel
let lnrpcDescriptor = grpc.loadPackageDefinition(packageDefinition);
let lnrpc = lnrpcDescriptor.lnrpc;
// TODO: replace 127.0.0.1:10009
let client = new lnrpc.Lightning('127.0.0.1:10009', credentials);


const getInfo = () => {
    client.getInfo({}, (err, response) => {
      if (err) {
        console.log('Error: ' + err);
      }
      console.log('GetInfo:', response);
    });
}

function openChannel() {
    const channelRequest = {
        // TODO: replace node_pubkey_string
        node_pubkey_string: 'node_pubkey_string',
        local_funding_amount: '500000', // Local funding amount in satoshis
    };

    client.openChannelSync(channelRequest, (error, response) => {
        if (error) {
            console.error('Error opening channel:', error);
        } else {
            console.log('Channel opened successfully:', response);
        }
    });
}

// getInfo();
// openChannel();