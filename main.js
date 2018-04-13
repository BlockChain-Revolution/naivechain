const CryptoJS = require("crypto-js")
const express = require("express")
const bodyParser = require('body-parser')
const WebSocket = require("ws")

const http_port = process.env.HTTP_PORT || 3001
const p2p_port = process.env.P2P_PORT || 6001
const initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : []

// 体系结构
// 需要指出的是，节点实际上展现了两个web服务器：
// 一个（HTTP服务器）是让用户控制节点，
// 另一个（Websocket HTTP服务器）
class Block {
    // 第一个逻辑步骤是决定块结构。
    // 为了保证事情尽可能的简单，我们只选择最必要的部分：
    // index（下标）
    // timestamp（时间戳）
    // data（数据）、hash（哈希值）
    // previous hash（前置哈希值）
    constructor(index, previousHash, timestamp, data, hash) {
        this.index = index
        this.previousHash = previousHash.toString()
        this.timestamp = timestamp
        this.data = data
        this.hash = hash.toString()
    }
}

var sockets = []
var MessageType = {
    QUERY_LATEST: 0, // 获取最新
    QUERY_ALL: 1, // 获取所有
    RESPONSE_BLOCKCHAIN: 2 // 从区块链中获取
}

// 块的存储
// 内存中的Javascript数组被用于存储区块链。区块链的第一个块通常被称为“起源块”，是硬编码的
const getGenesisBlock = () => {
    return new Block(0, "0", 1465154705, "my genesis block!!", "816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7");
}

let blockchain = [getGenesisBlock()]

// 结点控制
// 在某种程度上用户必须能够控制结点。这一点通过搭建一个HTTP服务器可以实现
// 用户可以用下面的方法和结点互动：
// 列出所有的块 curl http://localhost:3001/blocks
// 用用户提供的内容创建一个新的块 curl -H "Content-type:application/json" --data '{"data" : "Some data to the first block"}' http://localhost:3001/mineBlock
// 列出或者新增peers curl -H "Content-type:application/json" --data '{"peer" : "ws://localhost:6001"}' http://localhost:3001/addPeer
// 获取所有已连接的节点 curl http://localhost:3001/peers
var initHttpServer = () => {
    var app = express()
    app.use(bodyParser.json())

    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)))
    app.post('/mineBlock', (req, res) => {
        var newBlock = generateNextBlock(req.body.data)
        addBlock(newBlock)
        broadcast(responseLatestMsg())
        console.log('block added: ' + JSON.stringify(newBlock))
        res.send()
    });
    app.get('/peers', (req, res) => {
        res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort))
    });
    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer])
        res.send()
    });
    app.listen(http_port, () => console.log('Listening http on port: ' + http_port))
}

// 初始化P2P网络，用来接收块的信息
var initP2PServer = () => {
    var server = new WebSocket.Server({port: p2p_port})
    server.on('connection', ws => initConnection(ws))
    console.log('listening websocket p2p port on: ' + p2p_port)

}

var initConnection = (ws) => {
    sockets.push(ws)
    initMessageHandler(ws)
    initErrorHandler(ws)
    write(ws, queryChainLengthMsg())
}

var initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        console.log('Received message' + JSON.stringify(message))
        switch (message.type) {
            case MessageType.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break
            case MessageType.QUERY_ALL:
                write(ws, responseChainMsg());
                break
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message)
                break
        }
    })
}

var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url)
        sockets.splice(sockets.indexOf(ws), 1)
    };
    ws.on('close', () => closeConnection(ws))
    ws.on('error', () => closeConnection(ws))
}

// 块的生成
// 要生成一个块，必须知道前一个块的哈希值
// 然后创造其余所需的内容（= index, hash, data and timestamp）
// 块的data部分是由终端用户所提供的
var generateNextBlock = (blockData) => {
    var previousBlock = getLatestBlock()
    var nextIndex = previousBlock.index + 1
    var nextTimestamp = new Date().getTime() / 1000
    var nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData)
    return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash)
}


var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.data);
};

// 块哈希
// 为了保存完整的数据，必须哈希区块。
// SHA-256会对块的内容进行加密，记录这个值应该和“挖矿”毫无关系，因为这里不需要解决工作量证明的问题
var calculateHash = (index, previousHash, timestamp, data) => {
    return CryptoJS.SHA256(index + previousHash + timestamp + data).toString();
}

var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        blockchain.push(newBlock);
    }
}

// 确认块的完整性
// 在任何时候都必须能确认一个区块或者一整条链的区块是否完整。
// 在我们从其他节点接收到新的区块，并需要决定接受或拒绝它们时，这一点尤为重要。
var isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index')
        return false
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('invalid previoushash')
        return false
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock))
        console.log('invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash)
        return false
    }
    return true
}

var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        var ws = new WebSocket(peer)
        ws.on('open', () => initConnection(ws))
        ws.on('error', () => {
            console.log('connection failed')
        })
    })
}

var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index))
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1]
    var latestBlockHeld = getLatestBlock()
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("We can append the received block to our chain")
            blockchain.push(latestBlockReceived)
            broadcast(responseLatestMsg())
        } else if (receivedBlocks.length === 1) {
            console.log("We have to query the chain from our peer")
            broadcast(queryAllMsg())
        } else {
            console.log("Received blockchain is longer than current blockchain")
            replaceChain(receivedBlocks)
        }
    } else {
        console.log('received blockchain is not longer than current blockchain. Do nothing')
    }
}

// 选择最长的链
// 任何时候在链中都应该只有一组明确的块。万一冲突了（例如：两个结点都生成了72号块时）
// 会选择有最大数目的块的链
var replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain = newBlocks;
        broadcast(responseLatestMsg());
    } else {
        console.log('Received blockchain invalid');
    }
};

var isValidChain = (blockchainToValidate) => {
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    var tempBlocks = [blockchainToValidate[0]];
    for (var i = 1; i < blockchainToValidate.length; i++) {
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};

var getLatestBlock = () => blockchain[blockchain.length - 1];
var queryChainLengthMsg = () => ({'type': MessageType.QUERY_LATEST});
var queryAllMsg = () => ({'type': MessageType.QUERY_ALL});
var responseChainMsg = () =>({
    'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify(blockchain)
});
var responseLatestMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify([getLatestBlock()])
});

var write = (ws, message) => ws.send(JSON.stringify(message));
var broadcast = (message) => sockets.forEach(socket => write(socket, message));

connectToPeers(initialPeers);
initHttpServer();
initP2PServer();
