FROM nikolaik/python-nodejs:python3.12-nodejs20
RUN pip install --no-cache-dir fastmcp-gateway==0.33.0
CMD ["sh", "-c", "echo GATEWAY_UPSTREAMS=$GATEWAY_UPSTREAMS; exec python -m fastmcp_gateway"]
