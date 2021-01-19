const axios = require('axios');

const countryCodeLookup = require('country-code-lookup');

var { DateTime } = require('luxon');

var AWS = require('aws-sdk');
AWS.config.update({region:'eu-west-1'});
var ssm = new AWS.SSM();

function createGLSAddress(address, contactPerson) {
	var glsAddress = new Object(); 
	if (contactPerson != null) {
		glsAddress.contact = contactPerson.name;
		glsAddress.email = contactPerson.email;
		glsAddress.mobile = contactPerson.mobileNumber;
		glsAddress.phone = contactPerson.phoneNumber;
	} 
	glsAddress.name1 = address.addressee;
	glsAddress.street1 = address.streetNameAndNumber;
	glsAddress.zipCode = address.postalCode;
	glsAddress.city = address.cityTownOrVillage;
	glsAddress.countryNum = countryCodeLookup.byIso(address.countryCode).isoNo;
	return glsAddress;
}

exports.initializer = async (event, context) => {
	
} 

/**
 * A Lambda function that get shipping labels for parcels from GLS.
 */
exports.shippingLabelRequestHandler = async (event, context) => {
	
    const authUrl = "https://auth.thetis-ims.com/oauth2/";
    const apiUrl = "https://api.thetis-ims.com/2/";
    const glsUrl = "https://api.gls.dk/ws/DK/V1/";
    
    console.info(JSON.stringify(event));

    var apiKey = process.env.ApiKey;
    var contextId = process.env.ContextId;
    var detail = event.detail;
    var shipmentId = detail.shipmentId;

	var clientId = await ssm.getParameter({ Name: 'ThetisClientId', WithDecryption: true }).promise();   
	var clientSecret = await ssm.getParameter({ Name: 'ThetisClientSecret', WithDecryption: true }).promise();   
	
    let data = clientId.Parameter.Value + ":" + clientSecret.Parameter.Value;
	let base64data = Buffer.from(data, 'UTF-8').toString('base64');	
	
	var imsAuth = axios.create({
			baseURL: authUrl,
			headers: { Authorization: "Basic " + base64data, 'Content-Type': "application/x-www-form-urlencoded" },
			responseType: 'json'
		});
    
    var response = await imsAuth.post("token", 'grant_type=client_credentials');
    var token = response.data.token_type + " " + response.data.access_token;
    
    var ims = axios.create({
    		baseURL: apiUrl,
    		headers: { "Authorization": token, "x-api-key": apiKey }
    	});
	
	ims.interceptors.response.use(function (response) {
			console.log("SUCCESS " + JSON.stringify(response.data));
 	    	return response;
		}, function (error) {
			if (error.response) {
				console.log("FAILURE " + error.response.status + " - " + JSON.stringify(error.response.data));
			}
	    	return Promise.reject(error);
		});

    response = await ims.get("contexts/" + contextId);
    var context = response.data;

    var dataDocument = JSON.parse(context.dataDocument);
    var setup = dataDocument.GLSTransport;
    
    response = await ims.get("shipments/" + shipmentId);
    var shipment = response.data;
    
	var glsShipment = new Object();
	
	glsShipment.userName = setup.userName;
	glsShipment.password = setup.password;
	glsShipment.customerId = setup.customerId;
	glsShipment.contactid = setup.contactId;
	glsShipment.shipmentDate = DateTime.local().toFormat('yyyyMMdd');
	glsShipment.reference = shipment.shipmentNumber;
	
	let i = 1;
	var parcels = [];
	var shippingContainers = [];
	shippingContainers = shipment.shippingContainers;
	shippingContainers.forEach(function(shippingContainer) {
    		var glsParcel = new Object();
    		glsParcel.reference = shipment.shipmentNumber + " #" + i;
    		glsParcel.weight = shippingContainer.grossWeight;
    		parcels.push(glsParcel);
    		i++;
    	});
	
	glsShipment.parcels = parcels;
	
	var glsAddresses = new Object();
	
	var contactPerson = shipment.contactPerson;
	
	var glsDeliveryAddress = createGLSAddress(shipment.deliveryAddress, contactPerson);
	
	var senderAddress;
	var senderContactPerson;
    var sellerId = shipment.sellerId;
	if (sellerId != null) {
	    response = await ims.get("sellers/" + sellerId);
		senderAddress = response.data.address;
		senderContactPerson = response.data.contactPerson;
	} else {
		senderAddress = context.address;
		senderContactPerson = context.contactPerson;
	}
	var glsAlternativeShipper = createGLSAddress(senderAddress, senderContactPerson);
	
	glsAddresses.delivery = glsDeliveryAddress;
	glsAddresses.alternativeShipper = glsAlternativeShipper;
	
	glsShipment.addresses = glsAddresses;
	
	var glsServices = new Object();
	if (shipment.pickUpPointId != null) {
		glsServices.shopDelivery = shipment.getPickUpPointId;
	}	
	if (contactPerson != null) {
		glsServices.setNotificationEmail = contactPerson.getEmail;
	}
	var notesOnDelivery = shipment.notesOnDelivery;
	if (notesOnDelivery != null) {
		if (notesOnDelivery.startsWith("Deposit")) {
			glsServices.deposit = notesOnDelivery.substring(7);
		}
		if (notesOnDelivery.startsWith("Flex")) {
			glsServices.flexDelivery = "Y";
		}
		if (notesOnDelivery.startsWith("DirectShop")) {
			glsServices.directShop = "Y";
		}
		if (notesOnDelivery.startsWith("Private")) {
			glsServices.privateDelivery = "Y";
		}
	}
	glsShipment.services = glsServices;

    var gls = axios.create({
    		baseURL: glsUrl
    	});
	
	gls.interceptors.response.use(function (response) {
			console.log("SUCCESS " + JSON.stringify(response.data));
 	    	return response;
		}, function (error) {
			if (error.response) {
				console.log("FAILURE " + error.response.status + " - " + JSON.stringify(error.response.data));
				var message = new Object
				message.time = Date.now();
				message.source = "GLSTransport";
				message.messageType = "ERROR";
				message.messageText = error.response.data.Message;
				ims.post("events/" + detail.eventId + "/messages", message);
			}
	    	return Promise.reject(error);
		});
    
    response = await gls.post("CreateShipment", glsShipment);
    var glsResponse = response.data;
    
	var shippingLabel = new Object();
	shippingLabel.base64EncodedContent = glsResponse.PDF;
	shippingLabel.fileName = "SHIPPING_LABEL_" + shipmentId + ".pdf";
	await ims.post("shipments/"+ shipmentId + "/attachments", shippingLabel);

	await ims.put("shipments/" + shipmentId + "/consignmentId", glsResponse.consignmentId);
	
	var message = new Object
	message.time = Date.now();
	message.source = "GLSTransport";
	message.messageType = "INFO";
	message.messageText = "Labels are ready";
	await ims.post("events/" + detail.eventId + "/messages", message);

	return "done";

}
