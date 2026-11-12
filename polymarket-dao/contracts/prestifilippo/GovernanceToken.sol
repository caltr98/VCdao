// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";


/*
Smart Contract che implementa il token ERC20 usato per votare nella DAO e gestisce la componente stake
del voting power. La parte skill, i DID, gli issuer fidati e i checkpoint multi-topic sono gestiti dal
modulo separato GovernanceSkill.
Chiunque può unirsi alla DAO chiamando joinDAO() e inviando ETH.
Ogni votazione ha un topic, e per ogni topic GovernanceSkill calcola un VP skill diverso.

Formula per calcolare il voting power di un membro:
    VP_totale(account, topic) = VP_stake(account) + VP_skill(account, topic)

dove:
    VP_stake = componente economica, uguale per tutti i topic, derivata dai token ERC20Votes
            mintati quando il membro deposita ETH con joinDAO() o increaseStake().
    VP_skill = componente competenze, diversa per ogni topic della proposta,
    calcolata da GovernanceSkill al momento dell'upgrade competenze via VC e salvata in checkpoint.

La componente economica riprende la formula:
   scoreStake = min(stakeDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100]
   VP_stake = weightStake × scoreStake

La componente skill usa la formula:
VP_skill(account, topic) = weightSkill × scoreSkills
Lo score delle skills di un utente viene calcolato da SkillCalculator, chiamato dal modulo GovernanceSkill.
Una DAO può sostituire il calcolatore e calcolare in modo diverso il voting power derivato da skill.

I pesi weightSkill e weightStake sono configurabili al deploy e la loro somma deve essere uguale a
10.000 basis points, cioè il 100%.
Entrambi i pesi sono immutabili. Se i pesi cambiassero in futuro, i checkpoint passati del voting
power (usati per le votazioni) rifletterebbero pesi diversi, e ricalcolarli sarebbe impossibile
in termini di gas. Per modificarli è necessario deployare nuovi contratti.
*/


/*
Il token eredita ERC20 per le funzionalità base del token (transfer, balanceOf, ecc.),
 e ERC20Votes per la gestione del potere di voto nella DAO, con checkpoint basati sul
blocco di inizio votazione e delega del potere di voto.

La parte competenze non viene mintata come balance ERC20: vive in GovernanceSkill, che mantiene i
checkpoint del VP skill per ogni diverso topic di voto.
*/


contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes {
  
    //  Costanti DAO
    
    uint256 public constant MAX_DEPOSIT = 100 ether;    //Deposito massimo per membro: 100 ETH
    uint256 public constant BASIS_POINTS = 10_000;      /// Denominatore basis points per effettuare i calcoli in %, che rappresenta il 100% = 10.000 bp.

    //  Stato configurabile

    uint256 public immutable weightStake;     // Peso della componente stake nella formula del voting power, espresso in basis points.
    uint256 public immutable weightSkill;     // Peso della componente skill.

    // Timelock e deployer non cambiano mai dopo il deploy.
    // Il deployer serve solo per il bootstrap iniziale; poi le modifiche passano dal Timelock.
    address public immutable timelock;      /// Indirizzo del TimelockController, cioè l'esecutore delle decisioni di governance.
    address public immutable deployer;      /// Indirizzo del deployer, cioè la il token, usato solo per il setup iniziale.

    address public treasury;       // Indirizzo del Treasury a cui vengono inoltrati gli ETH depositati dai membri.

    //  Stato per membro

    mapping(address => uint256) public stakeDeposited;  // Mapping che tiene traccia di quanti ETH ha depositato ogni membro.
    mapping(address => bool) public isMember;       // Mappa che tiene traccia degli indirizzi membri della DAO.


    //  Eventi

    event MemberJoined(address indexed member, uint256 stakeAmount, uint256 stakeTokensMinted);
    event StakeIncreased(address indexed member, uint256 stakeAmount, uint256 stakeTokensMinted);


    //  Errori

    error OnlyTimelock();
    error OnlyDeployer();
    error AlreadyMember();
    error NotMember();
    error ZeroDeposit();
    error ExceedsMaxDeposit();
    error ZeroAddress();
    error TreasuryNotSet();
    error TreasuryAlreadySet();
    error TreasuryTransferFailed();
    error InvalidWeights();
    error DepositTooSmall();
    error MaxDepositReached();
    error TokenRecipientNotMember(address recipient);
    error DelegatorNotMember(address delegator);
    error DelegateeNotMember(address delegatee);

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


    /*
    Costruttore che prende come input l'indirizzo del TimelockController della DAO,
    il peso delle competenze e il peso dello stake economico.
    Inizializza il token, l'indirizzo del timelock e del deployer, imposta weightStake
    e verifica che la somma dei pesi sia 10.000 basis points.
    */
    constructor(
        address _timelock,
        uint256 _weightSkill,
        uint256 _weightStake
    ) ERC20("CompetenceDAO Token", "COMP") ERC20Permit("CompetenceDAO Token") {
        if (_timelock == address(0)) revert ZeroAddress();
        if (_weightSkill + _weightStake != BASIS_POINTS) revert InvalidWeights();

        // Pesi e timelock sono configurati al deploy. I pesi potranno poi cambiare solo via governance.
        timelock = _timelock;
        deployer = msg.sender;
        weightStake = _weightStake;
        weightSkill = _weightSkill;
    }


    //  Setup & Settings

    /*  Funzione di setup one shot che Imposta l'indirizzo del Treasury. 
        Prende in input l'indirizzo del treasury e può essere chiamata una sola volta, solo dal deployer.
        È necessaria perché il Treasury viene deployato dopo il GovernanceToken.
    */
    function setTreasury(address _treasury) external onlyDeployer {
        if (treasury != address(0)) revert TreasuryAlreadySet();
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }


    /*  Formula calcolo voting power stake:
        scoreStake = min(stakeDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100]
        VP_stake = weightStake × scoreStake
    */

    //Funzione che calcola scoreStake = min(deposited / MAX_DEPOSIT, 1) × 100 ∈ [0, 100]
    function getStakeScoreForDeposit(uint256 deposited) public pure returns (uint256) {
        if (deposited >= MAX_DEPOSIT) return 100;
        return (deposited * 100) / MAX_DEPOSIT;
    }
    

    /*
    Funzione che calcola scoreStake = min(deposited / MAX_DEPOSIT, 1) × 100 ∈ [0, 100]
    Funzione che calcola i token da mintare per la componente stake della formula VPC.
    Si calcola weightStake × ΔscoreStake (solo l'incremento dello score)
    dove scoreStake = min(stakeDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100].
    Prende il vecchio score, il nuovo score, effettua la differenza e moltiplica
    per weightStake, calcolando i token da mintare. Il risultato è in wei (× 10^18).

    Es: weightStake=5000 bp, previousDeposit=5 ETH, depositAmount=3 ETH:
        oldScore=5, newScore=8, ΔscoreStake=3
        token = (3 × 5000 × 10^18) / 10000 = 1.5 × 10^18 token
    */
    function _calculateStakeTokens(uint256 depositAmount, uint256 previousDeposit) internal view returns (uint256) {
        uint256 oldEffective = previousDeposit > MAX_DEPOSIT ? MAX_DEPOSIT : previousDeposit;
        uint256 newTotal = previousDeposit + depositAmount;
        uint256 newEffective = newTotal > MAX_DEPOSIT ? MAX_DEPOSIT : newTotal;

        uint256 effectiveDiff = newEffective - oldEffective;

        // Calcolo ottimizzato per non perdere i decimali di precisione.
        // Equivale alla logica originale (scoreDiff * weightStake * 1e18) / BASIS_POINTS
        return (effectiveDiff * 100 * weightStake * 1e18) / (MAX_DEPOSIT * BASIS_POINTS);
    }

    /* Funzione usata dagli utenti per entrare nella DAO, chiamabile da chiunque, senza passare da una proposal.
       Può essere chiamata solo dagli utenti che non sono ancora membri della DAO. Controlla che il treasury abbia
       un indirizzo assegnato e che il deposito effettuato sia superiore a 0.
       joinDAO gestisce solo la membership: registra il nuovo membro e poi chiama increaseStake(), che contiene
       il flusso unico per deposito, calcolo dei token stake, mint e trasferimento degli ETH al Treasury.
       In questo modo increaseStake() resta chiamabile solo dai membri, inclusi i nuovi membri registrati da joinDAO().
    */
    function joinDAO() external payable {
        if (treasury == address(0)) revert TreasuryNotSet();
        if (isMember[msg.sender]) revert AlreadyMember();
        if (msg.value == 0) revert ZeroDeposit();

        isMember[msg.sender] = true;
        uint256 tokenAmount = increaseStake();

        emit MemberJoined(msg.sender, msg.value, tokenAmount);
    }

    /* Funzione che minta i token successivamente all'ingresso del membro nella DAO, depositando ETH.
       La funzione controlla che il membro sia effettivamente un membro della DAO, che il treasury abbia un indirizzo assegnato
       e che il deposito inviato sia superiore a 0.
       Controlla che gli ETH depositati dal membro sommati a quelli che sta per depositare non superino MAX_DEPOSIT.
       Calcola il numero di token da ricevere in base al deposito effettuato via formula VPC, usando le funzioni di utility precedenti.
       Calcola i nuovi token in base solo all'incremento dello score stake e tiene conto degli ETH già depositati.
       Viene aggiornato il conto degli ETH depositati dall'utente. Vengono mintati i token se weightStake > 0.
       In modalita' only-competences, l'aumento di stake resta registrato come capitale depositato ma non genera token.
       Gli ETH vengono trasferiti direttamente al Treasury.

       Regola anti-bypass: se un utente ha depositato il massimo depositabile (senza tenere conto
       del suo saldo attuale di token, che potrebbe aver trasferito), non può più effettuare minting.
    */
    function increaseStake() public payable returns (uint256 newTokens) {
        if (!isMember[msg.sender]) revert NotMember();
        if (msg.value == 0) revert ZeroDeposit();
        if (treasury == address(0)) revert TreasuryNotSet();
        if (stakeDeposited[msg.sender] >= MAX_DEPOSIT) revert MaxDepositReached();
        if (stakeDeposited[msg.sender] + msg.value > MAX_DEPOSIT) revert ExceedsMaxDeposit();

        newTokens = _calculateStakeTokens(msg.value, stakeDeposited[msg.sender]);
        if (newTokens == 0 && weightStake > 0) revert DepositTooSmall();

        stakeDeposited[msg.sender] += msg.value;
        if (newTokens > 0) _mint(msg.sender, newTokens);
        (bool ok, ) = treasury.call{value: msg.value}("");
        if (!ok) revert TreasuryTransferFailed();
        emit StakeIncreased(msg.sender, msg.value, newTokens);
    }

    // Restituisce lo Score stake leggibile per UI/test;
    function getStakeScore(address _member) public view returns (uint256) {
        return getStakeScoreForDeposit(stakeDeposited[_member]);
    }

    // =========================================================================
    //  Override ereditarietà
    // =========================================================================

    // Hook richiesto da ERC20Votes per aggiornare i checkpoint dei token stake.
    // address(0) identifica un burn; ogni altro destinatario deve appartenere alla DAO.
    // joinDAO imposta la membership prima del mint, quindi anche il mint segue la stessa regola.
    function _update(address from, address to, uint256 amount) internal override(ERC20, ERC20Votes) {
        if (to != address(0) && !isMember[to]) revert TokenRecipientNotMember(to);
        super._update(from, to, amount);
    }

    // Punto unico usato sia da delegate() sia da delegateBySig().
    function _delegate(address account, address delegatee) internal override {
        if (!isMember[account]) revert DelegatorNotMember(account);
        // address(0) resta consentito per rimuovere una delega esistente.
        if (delegatee != address(0) && !isMember[delegatee]) revert DelegateeNotMember(delegatee);
        super._delegate(account, delegatee);
    }

    // Risolve il conflitto di ereditarieta' tra ERC20Permit e Nonces.
    function nonces(address owner) public view virtual override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
