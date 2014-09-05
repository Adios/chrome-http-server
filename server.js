if (http.server) {
	var prpr = http.server(),
		// pattern to parse host for transparent proxy.
		pattern = /^GET http:\/\/([^\/]+)\//m;

	// http transparent proxy server
	prpr.onRequest.addListener(prprOnRequest);
	prpr.listen(1227);

	// normal http server
	http.server(onServe).listen(1989);
}

function onServe(req, response) {
	var data = new ArrayBuffer(8);

	if (!req.http) {
		req.client.close();
		return;
	}
	// response.writeHead(404, { 'Content-Length': 0 });
	// response.end();
	response.writeHead(200, { 'Content-Length': data.byteLength });
	response.end(data);
}

function prprOnRequest(req, response) {
	var m;

	if (!req.http || !(m = req.data.match(pattern))) {
		req.client.close();
		return;
	}

	console.log(req.data);

	// req.client.pipe(m[1], req.buffer);

	req.client.pipe(m[1], req.buffer, function(data) {
		// data: a complete http response with respect to this request.
	});
}
