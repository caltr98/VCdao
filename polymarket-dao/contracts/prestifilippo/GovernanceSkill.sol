// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "./VPVerifier.sol";
import "./ISkillCalculator.sol";
import "./IGovernanceToken.sol";
import "./SkillDefinitions.sol";

contract GovernanceSkill {
    using Checkpoints for Checkpoints.Trace208;

    uint256 public constant BASIS_POINTS = 10_000;      /// Denominatore basis points per effettuare i calcoli in %, che rappresenta il 100% = 10.000 bp.
    bytes32 public constant VC_PROOF_TYPEHASH = keccak256("VCProof(bytes32 credentialSubjectHash)");
    bytes9 private constant DID_ETHR_PREFIX = "did:ethr:";

    /// Domain separator canonico definito in VPVerifier e usato anche dall'emittente off-chain.
    bytes32 public constant UNIVERSAL_DOMAIN_SEPARATOR = VPVerifier.UNIVERSAL_DOMAIN_SEPARATOR;

    uint256 public immutable weightSkill;     // Peso della componente skill nella formula del voting power, espresso in basis points.

    // Timelock e deployer non cambiano mai dopo il deploy.
    // Il deployer serve solo per il bootstrap iniziale; poi le modifiche passano dal Timelock.
    address public immutable timelock;      /// Indirizzo del TimelockController, cioè l'esecutore delle decisioni di governance.
    address public immutable deployer;      /// Indirizzo del deployer, cioè la il token, usato solo per il setup iniziale.

    IGovernanceToken public immutable governanceToken;
    ISkillCalculator public immutable skillCalculator;   // Contratto esterno immutabile che calcola lo score skill per topic.
    
    mapping(address => bool) public trustedIssuers;  // Issuer attendibili dal contratto che firmano le Verifiable Credential contenenti le skill dei membri.
    uint256 public trustedIssuerCount;

    mapping(address => bytes32) public memberDID;    // Mappa che associa ogni membro all'hash del suo DID.
    mapping(bytes32 => address) public didToAddress; // Garantisce che lo stesso DID non venga registrato da due address.

    // Un solo slot per membro; SkillDefinitions assegna un bit a ciascuna skill.
    mapping(address => uint256) public memberSkillBitmap;


    // Checkpoint skill per topic

    //  _skillVotesCheckpoints[account][topicId]
    // storico cumulativo del voting power derivato da skill dell'utente, per quel determinato topic.
    // Associa l'indirizzo di un membro, al mapping che va dal topicId al voting power relativo.
    mapping(address => mapping(uint256 => Checkpoints.Trace208)) private _skillVotesCheckpoints;

    //  _totalSkillSupplyCheckpoints[topicId]:
    //  Tiene traccia della somma cumulativa di tutti i VP-skill emessi per quel topic, per tutti gli utenti.
    // Associa il topicId al voting power da skill totale accumulato.
    mapping(uint256 => Checkpoints.Trace208) private _totalSkillSupplyCheckpoints;

    event SkillUpgradedWithVC(address indexed member, bytes32 indexed issuerDidHash);
    event SkillUpgraded(address indexed member, bytes32 indexed proofHash);
    event TrustedIssuerAdded(address indexed issuer);
    event TrustedIssuerRemoved(address indexed issuer);
    event SkillCalculatorSet(address indexed calculator);
    event MemberSkillsMerged(address indexed member, uint256 addedSkills, uint256 totalSkills);
    event DIDRegistered(address indexed member, bytes32 indexed didHash);

    error OnlyTimelock();
    error OnlyDeployer();
    error NotMember();
    error ZeroAddress();
    error DIDMismatch();
    error DIDAlreadyRegistered();
    error DIDAlreadyBound();
    error NoDIDRegistered();
    error EmptyDID();
    error UnsupportedDID();
    error DIDControllerMismatch();
    error UntrustedIssuer();
    error TrustedIssuerNotSet();
    error TrustedIssuerAlreadySet();
    error CannotRemoveLastTrustedIssuer();
    error InvalidTopicId(uint256 topicId);
    error NotAContract();
    error InvalidCalculator();
    error InvalidWeights();
    error InvalidSkill(bytes32 skillId);
    error ERC5805FutureLookup(uint256 timepoint, uint48 clock);

    /// Decorator che obbliga la funzione interna ad essere eseguita solo dal TimeLockController.
    modifier onlyTimelock() {
        if (msg.sender != timelock) revert OnlyTimelock();
        _;
    }

    /// Decorator che obbliga la funzione interna ad essere eseguita solo dal deployer.
    modifier onlyDeployer() {
        if (msg.sender != deployer) revert OnlyDeployer();
        _;
    }

    constructor(
        address _governanceToken,
        address _timelock,
        uint256 _weightSkill,
        address _skillCalculator
    ) {
        if (_governanceToken == address(0)) revert ZeroAddress();
        if (_timelock == address(0)) revert ZeroAddress();
        if (_weightSkill > BASIS_POINTS) revert InvalidWeights();
        governanceToken = IGovernanceToken(_governanceToken);
        timelock = _timelock;
        deployer = msg.sender;
        weightSkill = _weightSkill;
        skillCalculator = _validateSkillCalculator(_skillCalculator);
        emit SkillCalculatorSet(_skillCalculator);
    }

    /*
    Funzione che configura gli issuer fidati, che firmano le VC riconosciute dal contratto. 
       Il primo issuer può impostarlo solo il deployer. 
       Dopo la prima configurazione, solo la governance può cambiarlo o aggiungere altri issuer.
    */
    function setTrustedIssuer(address _issuer) external {
        if (_issuer == address(0)) revert ZeroAddress();
        if (trustedIssuers[_issuer]) revert TrustedIssuerAlreadySet();

        if (trustedIssuerCount == 0) {
            if (msg.sender != deployer) revert OnlyDeployer();
        } else {
            if (msg.sender != timelock) revert OnlyTimelock();
        }

        trustedIssuers[_issuer] = true;
        trustedIssuerCount++;
        emit TrustedIssuerAdded(_issuer);
    }

    // Rimuove un issuer dall'insieme fidato. Puo farlo solo la governance.
    function removeTrustedIssuer(address _issuer) external onlyTimelock {
        if (!trustedIssuers[_issuer]) revert UntrustedIssuer();
        if (trustedIssuerCount == 1) revert CannotRemoveLastTrustedIssuer();

        trustedIssuers[_issuer] = false;
        trustedIssuerCount--;

        emit TrustedIssuerRemoved(_issuer);
    }

    /*
        Valida il calcolatore delle skill, che implementa l'interfaccia ISkillCalculator.
        Il calcolatore viene fissato al deploy per evitare che membri diversi vengano
        valutati con logiche differenti nel tempo.
    */
    function _validateSkillCalculator(address _calculator) internal view virtual returns (ISkillCalculator) {
        if (_calculator == address(0)) revert ZeroAddress();
        if (_calculator.code.length == 0) revert NotAContract();

        ISkillCalculator candidate = ISkillCalculator(_calculator);
        try candidate.calculateAllVPFromBitmap(0) returns (uint256[] memory scores) {
            if (scores.length != _topicCount()) revert InvalidCalculator();
            for (uint256 topicId = 0; topicId < _topicCount(); topicId++) {
                if (scores[topicId] > 100) revert InvalidCalculator();
            }
        } catch {
            revert InvalidCalculator();
        }

        return candidate;
    }


    // Espone lo stesso clock del GovernanceToken, così i checkpoint skill dichiarano esplicitamente la stessa base temporale dello stake.
    function clock() public view returns (uint48) {
        return governanceToken.clock();
    }

    // Espone la stessa modalità del clock del GovernanceToken, per compatibilità con lo standard ERC-5805.
    function CLOCK_MODE() public view returns (string memory) {
        return governanceToken.CLOCK_MODE();
    }

    function supportedTopics(uint256 topicId) public view returns (bool) {
        return isValidTopic(topicId);
    }

    function supportedSkills(bytes32 skillId) public view returns (bool) {
        return isValidSkill(skillId);
    }

    function getSupportedTopics() external view virtual returns (uint256[] memory topics) {
        return SkillDefinitions.supportedTopics();
    }

    function getSupportedSkills() external view virtual returns (bytes32[] memory skills) {
        return SkillDefinitions.supportedSkills();
    }

    // La validazione dei topic viene mantenuta nel modulo skill della DAO.
    function isValidTopic(uint256 topicId) public view returns (bool) {
        return topicId < _topicCount();
    }

    function isValidSkill(bytes32 skillId) public view returns (bool) {
        return _skillFlag(skillId) != 0;
    }




    //  DID

    /*
        Registra il DID del membro una sola volta.
        Il DID resta salvato come hash per ridurre storage e privacy leak.
        La verifica forte avviene quando una VC firmata da un issuer fidato
        presenta lo stesso DID nel credentialSubject.
    */
    function registerDID(string calldata _did) external {
        if (!governanceToken.isMember(msg.sender)) revert NotMember();
        if (bytes(_did).length == 0) revert EmptyDID();

        address holderAddress = _parseSupportedEthrDID(_did);
        if (holderAddress != msg.sender) revert DIDControllerMismatch();

        if (memberDID[msg.sender] != bytes32(0)) revert DIDAlreadyRegistered();

        bytes32 didHash = keccak256(bytes(_did));
        if (didToAddress[didHash] != address(0)) revert DIDAlreadyBound();

        memberDID[msg.sender] = didHash;
        didToAddress[didHash] = msg.sender;

        emit DIDRegistered(msg.sender, didHash);
    }

    // Estrae il controller dal formato canonico usato dalla DAO:
    // did:ethr:0x<address>.
    function _parseSupportedEthrDID(string calldata _did) private pure returns (address) {
        bytes calldata did = bytes(_did);
        if (did.length != 51 || bytes9(did[0:9]) != DID_ETHR_PREFIX) {
            revert UnsupportedDID();
        }

        uint256 addressStart = 9;
        if (did[addressStart] != bytes1("0") || did[addressStart + 1] != bytes1("x")) {
            revert UnsupportedDID();
        }

        uint160 parsedAddress;
        unchecked {
            for (uint256 i = addressStart + 2; i < did.length; i++) {
                uint8 character = uint8(did[i]);
                uint8 nibble;

                if (character >= 48 && character <= 57) {
                    nibble = character - 48;
                } else if (character >= 65 && character <= 70) {
                    nibble = character - 55;
                } else if (character >= 97 && character <= 102) {
                    nibble = character - 87;
                } else {
                    revert UnsupportedDID();
                }

                parsedAddress = (parsedAddress << 4) | uint160(nibble);
            }
        }

        return address(parsedAddress);
    }




    //  Upgrade Skill

    // Ricostruisce gli hash in ordine canonico di bit, senza un array in storage.
    function getMemberSkills(address member) public view returns (bytes32[] memory) {
        return _skillsFromBitmap(memberSkillBitmap[member]);
    }

    // Controlla se un membro possiede una skill.
    function hasSkill(address member, bytes32 skillId) public view returns (bool) {
        return (memberSkillBitmap[member] & _skillFlag(skillId)) != 0;
    }

    // Valida tutte le skill prima di scrivere; l'OR elimina automaticamente i duplicati.
    function _mergeSkills(address member, string[] memory skillNames) internal returns (uint256 bitmap, bool changed) {
        uint256 oldBitmap = memberSkillBitmap[member];
        bitmap = oldBitmap;
        for (uint256 i = 0; i < skillNames.length; i++) {
            bytes32 skillId = SkillDefinitions.skillId(skillNames[i]);
            uint256 flag = _skillFlag(skillId);
            if (flag == 0) revert InvalidSkill(skillId);
            bitmap |= flag;
        }
        changed = bitmap != oldBitmap;
        if (changed) {
            memberSkillBitmap[member] = bitmap;
            emit MemberSkillsMerged(
                member,
                SkillDefinitions.countSkills(bitmap ^ oldBitmap),
                SkillDefinitions.countSkills(bitmap)
            );
        }
    }



    /*
        Upgrade amministrativo via governance No VC, usato a fini di test.
        Il Timelock passa skill testuali approvate da una proposta.
    */
    function upgradeSkill(
        address _member,
        string[] calldata _skills,
        bytes32 _proofHash
    ) external onlyTimelock {
        if (!governanceToken.isMember(_member)) revert NotMember();
        (uint256 bitmap, bool changed) = _mergeSkills(_member, _skills);
        if (changed) _performUpgrade(_member, bitmap);
        emit SkillUpgraded(_member, _proofHash);
    }

    /*
    Funzione che esegue l'upgrade delle skill di un membro tramite VC.
    Usa la libreria VPVerifier per verificare una VC firmata e applica l'upgrade se la VC è valida.
    La funzione controlla se il membro è esistente e se è configurato nella DAO l'issuer fidato.
    Controlla se il DID del membro è coerente con il DID nel credentialSubject.
    Il typehash del dominio EIP-712 è precalcolato come constant (0 gas di hashing).
    Recupera l'address del firmatario usando le funzioni della libreria VPVerifier sulla firma EIP-712 
    contenuta nella VC.
    Controlla che il signer recuperato sia trusted e coerente con il DID dell'issuer.
    Costruisce un hash della proof sintetica da esporre negli eventi. 
    Esegue l'aggiornamento delle skill del membro tramite _performUpgrade, senza passare dalla governance.
    */
    function upgradeSkillWithVC(
        VPVerifier.VerifiableCredential memory _vc,
        bytes memory _issuerSignature
    ) external {
        if (!governanceToken.isMember(msg.sender)) revert NotMember();
        if (trustedIssuerCount == 0) revert TrustedIssuerNotSet();
        bytes32 didHash = memberDID[msg.sender];
        if (didHash == bytes32(0)) revert NoDIDRegistered();
        if (keccak256(bytes(_vc.credentialSubject.id)) != didHash) revert DIDMismatch();

        address recovered = VPVerifier.recoverIssuer(_vc, _issuerSignature);
        if (!trustedIssuers[recovered]) revert UntrustedIssuer();

        (uint256 bitmap, bool changed) = _mergeSkills(msg.sender, _vc.credentialSubject.skills);

        bytes32 issuerDidHash = keccak256(bytes(_vc.issuer.id));
        bytes32 proofHash = _credentialSubjectProofHash(_vc.credentialSubject);
        if (changed) _performUpgrade(msg.sender, bitmap);

        emit SkillUpgraded(msg.sender, proofHash);
        emit SkillUpgradedWithVC(msg.sender, issuerDidHash);
    }

    /*
        Proof sintetica per gli eventi: lega l'upgrade al CredentialSubject certificato
        (holder DID, organization, unit e hash ordinato delle skill) senza salvare stringhe on-chain.
        VPVerifier resta responsabile solo dell'hashing EIP-712 della VC; GovernanceSkill decide
        quale proof esporre nella logica DAO.
    */
    function _credentialSubjectProofHash(
        VPVerifier.CredentialSubject memory credentialSubject
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                VC_PROOF_TYPEHASH,
                VPVerifier.hashCredentialSubject(credentialSubject)
            )
        );
    }

    /*
    Funzione di upgrade di competenza, che si occupa di effettuare nella DAO le modifiche
    al voting power del membro dopo che la VC è stata verificata (oppure dopo che il Timelock ha autorizzato
    l'upgrade legacy).
    Passa la bitmap al calcolatore in una sola chiamata e aggiorna i checkpoint:
        VPSkills(bitmap, t) = score(bitmap, t) × weightSkill × 10^18 / BASIS_POINTS.
    Senza nuove skill il chiamante evita calcolo e checkpoint, ma mantiene gli eventi.
    */
    function _performUpgrade(
        address _member,
        uint256 _skillBitmap
    ) internal {
        uint48 blk = clock();
        uint256[] memory scores = skillCalculator.calculateAllVPFromBitmap(_skillBitmap);
        uint256 topicCount = _topicCount();
        if (scores.length != topicCount) revert InvalidCalculator();

        for (uint256 topicId = 0; topicId < topicCount; topicId++) {
            uint256 score = scores[topicId];
            if (score > 100) revert InvalidCalculator();
            uint256 newVP = (score * weightSkill * 1e18) / BASIS_POINTS;

            _writeSkillVotes(_member, topicId, newVP, blk);
        }

    }

    /*
        Scrive il nuovo valore assoluto di VP skill.
        Aggiorna anche la total supply del topic applicando solo la differenza
        tra vecchio e nuovo valore. Cosi' supporta sia aumenti sia eventuali
        diminuzioni future dovute a un nuovo SkillCalculator.
    */
   /*
    Funzione che aggiunge il voting power da skill aggiuntivo per un dato topic
    ai checkpoint del membro e alla supply totale del topic. Supporta anche downgrade se il voting power diminuisce.
    I checkpoint permettono al Governor di leggere il Voting power storico derivato da skill al blocco di snapshot
    della proposta, evitando che upgrade successivi modifichino votazioni già iniziate.
    La funzione crea un record sul checkpoint dell VP del membro per il topic. Salva il nuovo valore del VP nel membro.
    Poi crea il record per il checkpoint sulla totalSupply. Confronta il VP attuale del membro con quello dell'ultimo checkpoint.
    Se il VP è aumentato, aggiunge la differenza, mentre se è diminuito sottrae la differenza.
    */
    function _writeSkillVotes(
        address account,
        uint256 topicId,
        uint256 newVP,
        uint48 checkpointKey
    ) internal {
        Checkpoints.Trace208 storage userTrace = _skillVotesCheckpoints[account][topicId];
        uint208 oldVotes = userTrace.latest();
        uint208 newVotes = SafeCast.toUint208(newVP);
        if (newVotes == oldVotes) return;

        Checkpoints.Trace208 storage totalTrace = _totalSkillSupplyCheckpoints[topicId];
        uint208 oldTotal = totalTrace.latest();

        userTrace.push(checkpointKey, newVotes);

        if (newVotes > oldVotes) {
            totalTrace.push(checkpointKey, oldTotal + (newVotes - oldVotes));
        } else {
            totalTrace.push(checkpointKey, oldTotal - (oldVotes - newVotes));
        }
    }

    // Validazione interna usata dai getter topic-aware.
    function _validateTopicId(uint256 topicId) internal view {
        if (!isValidTopic(topicId)) revert InvalidTopicId(topicId);
    }

    // La versione Polymarket estende il catalogo; la bitmap e i checkpoint restano gli stessi.
    function _topicCount() internal view virtual returns (uint256) {
        return SkillDefinitions.TOPIC_COUNT;
    }

    function _skillFlag(bytes32 skillId) internal view virtual returns (uint256) {
        return SkillDefinitions.skillFlag(skillId);
    }

    function _skillsFromBitmap(uint256 bitmap) internal view virtual returns (bytes32[] memory) {
        return SkillDefinitions.skillsFromBitmap(bitmap);
    }

    // =========================================================================
    //  Getter pubblici
    // =========================================================================

    // Restituisce il checkpint del VP skill corrente del membro su un topic.
    function getSkillVotes(address account, uint256 topicId) public view returns (uint256) {
        _validateTopicId(topicId);
        return _skillVotesCheckpoints[account][topicId].latest();
    }

    // Restituisce il VP skill storico del membro al Governor, al blocco di snapshot della proposta.
    function getPastSkillVotes(address account, uint256 topicId, uint256 timepoint) public view returns (uint256) {
        _validateTopicId(topicId);
        uint48 cur = clock();
        if (timepoint >= cur) revert ERC5805FutureLookup(timepoint, cur);
        return _skillVotesCheckpoints[account][topicId].upperLookupRecent(SafeCast.toUint48(timepoint));
    }

    // Restituisce il checkpoint della TotalSupply VP skill corrente di un topic.
    function getTotalSkillSupply(uint256 topicId) public view returns (uint256) {
        _validateTopicId(topicId);
        return _totalSkillSupplyCheckpoints[topicId].latest();
    }

    // Restituisce il checkpoint della TotalSupply VP skill corrente di un topic, ad un certo timepoint
    function getPastTotalSkillSupply(uint256 topicId, uint256 timepoint) public view returns (uint256) {
        _validateTopicId(topicId);
        uint48 cur = clock();
        if (timepoint >= cur) revert ERC5805FutureLookup(timepoint, cur);
        return _totalSkillSupplyCheckpoints[topicId].upperLookupRecent(SafeCast.toUint48(timepoint));
    }
}
